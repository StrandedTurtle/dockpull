/**
 * Docker engine integration: read-only inspection via dockerode, plus
 * compose-based (and standalone-fallback) container updates via `docker`
 * CLI subprocesses spawned with argv arrays (never a shell string).
 *
 * NOTE: this module talks to the Docker daemon, so listContainers/
 * updateContainer can only be exercised against a real daemon on the
 * user's host — they are not covered by the pure unit tests in
 * server/test/. See the work package report for what still needs
 * host-side verification.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Docker from 'dockerode';
import { config } from './config.js';
import { normalizeRef, parseRef } from './reconcile.js';

// Best-effort identity of this app's own container, so listContainers can
// exclude it (you can't safely update the updater from within itself). By
// default Docker sets a container's hostname to its short id.
const SELF_HOSTNAME = os.hostname();

function isSelfContainer(name, id) {
  if (config.SELF_CONTAINER_NAME && name === config.SELF_CONTAINER_NAME) return true;
  if (SELF_HOSTNAME && id && id.startsWith(SELF_HOSTNAME)) return true;
  return false;
}

// Constructing the client does not connect to the daemon — it just sets
// up the socket path to dial on first request. Safe to do at import time.
const docker = new Docker({ socketPath: config.DOCKER_SOCKET });

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const COMPOSE_CONFIG_FILES_LABEL = 'com.docker.compose.project.config_files';
const COMPOSE_WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';

const COMPOSE_FILE_CANDIDATES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
];

/**
 * Strips the leading slash Docker prefixes onto container names.
 * @param {string} rawName
 * @returns {string}
 */
function stripLeadingSlash(rawName) {
  if (typeof rawName !== 'string') return rawName;
  return rawName.startsWith('/') ? rawName.slice(1) : rawName;
}

/**
 * Pure: every digest in an image's `RepoDigests` that belongs to the
 * configured image ref's repo. An image can legitimately carry several digests
 * for the same repo — e.g. it was pulled under two tags whose manifest lists
 * differ only in annotations, or the publisher re-pushed the tag's index
 * (adding attestations) without changing the image itself. Docker lists them
 * in lexical order, not newest-first, so any one of them may be the digest the
 * registry currently serves; callers must compare against all of them. Falls
 * back to the sole RepoDigest if there's exactly one and no repo match.
 *
 * @param {string[]|undefined} repoDigests - image inspect `RepoDigests`.
 * @param {string} image - configured image ref, e.g. "nginx:latest".
 * @returns {string[]}
 */
export function pickRepoDigests(repoDigests, image) {
  if (!Array.isArray(repoDigests) || repoDigests.length === 0) {
    return [];
  }

  // Determine the repo (registry/repo, no tag) we're looking for.
  let wantedRepo = null;
  try {
    const { registry, repository } = parseRef(image);
    wantedRepo = `${registry}/${repository}`;
  } catch {
    wantedRepo = null;
  }

  const matches = [];
  if (wantedRepo) {
    for (const entry of repoDigests) {
      const atIdx = entry.lastIndexOf('@');
      if (atIdx === -1) continue;
      let entryRepo;
      try {
        const { registry, repository } = parseRef(entry);
        entryRepo = `${registry}/${repository}`;
      } catch {
        entryRepo = entry.slice(0, atIdx);
      }
      const digest = entry.slice(atIdx + 1);
      if (entryRepo === wantedRepo && !matches.includes(digest)) {
        matches.push(digest);
      }
    }
  }
  if (matches.length > 0) return matches;

  // No repo match found; fall back to the sole RepoDigest's digest part, but
  // only if there's exactly one (otherwise it's ambiguous which applies).
  if (repoDigests.length === 1) {
    const atIdx = repoDigests[0].lastIndexOf('@');
    return atIdx === -1 ? [] : [repoDigests[0].slice(atIdx + 1)];
  }

  return [];
}

/**
 * Inspects an image once and returns both the running digest (matched to the
 * configured ref) and the human-readable version from the
 * `org.opencontainers.image.version` label, if the image sets it. Returns
 * nulls if the image can't be inspected.
 *
 * @param {string} imageIdOrName - `Image` field from container inspect.
 * @param {string} image - configured image ref, e.g. "nginx:latest".
 * @returns {Promise<{ digest: string|null, digests: string[], version: string|null, source: string|null }>}
 */
async function inspectImageMeta(imageIdOrName, image) {
  let imageInfo;
  try {
    imageInfo = await docker.getImage(imageIdOrName).inspect();
  } catch (err) {
    console.warn(`docker.js: failed to inspect image ${imageIdOrName}: ${err.message}`);
    return { digest: null, digests: [], version: null, source: null };
  }

  const labels = imageInfo?.Config?.Labels || {};
  const version = labels['org.opencontainers.image.version'] || null;
  const source = normalizeSourceUrl(
    labels['org.opencontainers.image.source'] || labels['org.opencontainers.image.url'] || null
  );
  const digests = pickRepoDigests(imageInfo?.RepoDigests, image);
  return { digest: digests[0] ?? null, digests, version, source };
}

/**
 * Normalizes an OCI source/url label into a plain https web URL, or null.
 * Handles `git+https://`, `git@github.com:org/repo.git`, and trailing `.git`.
 *
 * @param {string|null} raw
 * @returns {string|null}
 */
function normalizeSourceUrl(raw) {
  if (typeof raw !== 'string') return null;
  let url = raw.trim();
  if (url === '') return null;
  url = url.replace(/^git\+/, '');
  // scp-style git remote: git@github.com:org/repo(.git)
  const scp = url.match(/^git@([^:]+):(.+)$/);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  url = url.replace(/\.git$/, '');
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

/**
 * Resolves the digest the running container's image was created from. Thin
 * wrapper over inspectImageMeta for callers that only need the digest.
 *
 * @param {string} imageIdOrName - `Image` field from container inspect.
 * @param {string} image - configured image ref, e.g. "nginx:latest".
 * @returns {Promise<string|null>}
 */
async function resolveCurrentDigest(imageIdOrName, image) {
  return (await inspectImageMeta(imageIdOrName, image)).digest;
}

/**
 * Resolves compose project/service/composeFile/workingDir for a container
 * from its labels, falling back to a STACKS_DIR scan if the
 * config_files/working_dir labels are absent but the project label is
 * present.
 *
 * @param {object} labels - container Labels object (may be undefined).
 * @returns {{ project: string|null, service: string|null, composeFile: string|null, workingDir: string|null }}
 */
function composeInfoFromLabels(labels) {
  const l = labels || {};
  const project = l[COMPOSE_PROJECT_LABEL] || null;
  const service = l[COMPOSE_SERVICE_LABEL] || null;
  const workingDirLabel = l[COMPOSE_WORKING_DIR_LABEL] || null;
  const configFilesLabel = l[COMPOSE_CONFIG_FILES_LABEL] || null;

  let composeFile = null;
  let workingDir = workingDirLabel || null;

  if (configFilesLabel) {
    const first = configFilesLabel.split(',')[0].trim();
    if (first) {
      composeFile = workingDir && !path.isAbsolute(first) ? path.resolve(workingDir, first) : first;
      if (!workingDir) {
        workingDir = path.dirname(path.resolve(composeFile));
      }
    }
  }

  return { project, service, composeFile, workingDir };
}

/**
 * Searches `config.STACKS_DIR/<project>/` for a known compose filename.
 *
 * @param {string} project
 * @returns {{ composeFile: string, workingDir: string }|null}
 */
function findComposeFileForProject(project) {
  const dir = path.join(config.STACKS_DIR, project);
  for (const candidate of COMPOSE_FILE_CANDIDATES) {
    const full = path.join(dir, candidate);
    try {
      if (fs.existsSync(full)) {
        return { composeFile: full, workingDir: dir };
      }
    } catch {
      // ignore and try next candidate
    }
  }
  return null;
}

/**
 * Resolves compose info ({ project, service, composeFile, workingDir }) for
 * a container, given either its name or an already-fetched inspect object.
 * Prefers labels; falls back to scanning STACKS_DIR/<project>/ for a known
 * compose filename if the project is known but config_files/working_dir
 * labels are missing.
 *
 * @param {string|object} nameOrContainer
 * @returns {Promise<{ project: string|null, service: string|null, composeFile: string|null, workingDir: string|null }|null>}
 */
export async function getComposeInfo(nameOrContainer) {
  let inspectData;
  if (typeof nameOrContainer === 'string') {
    try {
      inspectData = await docker.getContainer(nameOrContainer).inspect();
    } catch (err) {
      console.warn(`docker.js: getComposeInfo failed to inspect ${nameOrContainer}: ${err.message}`);
      return null;
    }
  } else {
    inspectData = nameOrContainer;
  }

  const labels = inspectData?.Config?.Labels;
  const fromLabels = composeInfoFromLabels(labels);

  if (fromLabels.composeFile && fromLabels.workingDir) {
    return fromLabels;
  }

  if (fromLabels.project) {
    const found = findComposeFileForProject(fromLabels.project);
    if (found) {
      return {
        project: fromLabels.project,
        service: fromLabels.service,
        composeFile: found.composeFile,
        workingDir: found.workingDir,
      };
    }
  }

  if (!fromLabels.project && !fromLabels.service && !fromLabels.composeFile) {
    return null;
  }

  return fromLabels;
}

/**
 * Lists all containers (including stopped ones) with the fields needed by
 * the `/api/containers` endpoint's docker-derived data. Skips (with a
 * logged warning) any container that fails to inspect, rather than
 * throwing and failing the whole list.
 *
 * @returns {Promise<Array<{
 *   name: string, image: string, currentDigest: string|null,
 *   project: string|null, service: string|null, composeFile: string|null,
 *   workingDir: string|null, state: string, normalizedRef: string
 * }>>}
 */
export async function listContainers() {
  const summaries = await docker.listContainers({ all: true });
  const results = [];

  for (const summary of summaries) {
    try {
      const container = docker.getContainer(summary.Id);
      const inspectData = await container.inspect();

      const name = stripLeadingSlash(inspectData.Name);

      // Never list our own container — offering to update it would recreate
      // the container running this process mid-update.
      if (isSelfContainer(name, summary.Id)) {
        continue;
      }

      const image = inspectData.Config?.Image;
      if (!image) {
        console.warn(`docker.js: container ${name} has no Config.Image, skipping`);
        continue;
      }

      const {
        digest: currentDigest,
        digests: currentDigests,
        version: currentVersion,
        source: sourceUrl,
      } = await inspectImageMeta(inspectData.Image, image);

      const labels = inspectData.Config?.Labels;
      const labelInfo = composeInfoFromLabels(labels);
      let { project, service, composeFile, workingDir } = labelInfo;

      if (!composeFile || !workingDir) {
        const composeInfo = await getComposeInfo(inspectData);
        if (composeInfo) {
          project = project || composeInfo.project;
          service = service || composeInfo.service;
          composeFile = composeFile || composeInfo.composeFile;
          workingDir = workingDir || composeInfo.workingDir;
        }
      }

      let normalizedRef;
      let tag = null;
      try {
        normalizedRef = normalizeRef(image);
        tag = parseRef(image).tag;
      } catch (err) {
        console.warn(`docker.js: failed to normalize ref "${image}" for ${name}: ${err.message}`);
        continue;
      }

      // Flag compose-managed containers whose compose file isn't reachable
      // from inside this container (the same-path mount is missing/wrong), so
      // the dashboard can warn before an update is attempted.
      const composeFileMissing = Boolean(composeFile) && !fs.existsSync(composeFile);

      results.push({
        name,
        image,
        tag,
        currentVersion,
        sourceUrl: sourceUrl || null,
        currentDigest,
        currentDigests,
        project: project || null,
        service: service || null,
        composeFile: composeFile || null,
        composeFileMissing,
        workingDir: workingDir || null,
        state: inspectData.State?.Status || summary.State || 'unknown',
        normalizedRef,
      });
    } catch (err) {
      console.warn(`docker.js: failed to inspect container ${summary.Id}: ${err.message}`);
      // skip this container, continue with the rest
    }
  }

  return results;
}

/**
 * Spawns a command with argv (never a shell string), streaming stdout and
 * stderr lines to `onLine(line, stream)` as they arrive, and resolves with
 * the exit code plus the captured tail of output (for error messages).
 *
 * @param {string} command
 * @param {string[]} args
 * @param {(line: string, stream: 'stdout'|'stderr') => void} [onLine]
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<{ code: number, tail: string }>}
 */
function spawnAndStream(command, args, onLine, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, shell: false });

    const tailLines = [];
    const MAX_TAIL_LINES = 50;

    function pushTail(line) {
      tailLines.push(line);
      if (tailLines.length > MAX_TAIL_LINES) {
        tailLines.shift();
      }
    }

    function handleChunk(stream) {
      let buffer = '';
      return (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          pushTail(line);
          if (typeof onLine === 'function') {
            try {
              onLine(line, stream);
            } catch (err) {
              console.warn(`docker.js: onLine callback threw: ${err.message}`);
            }
          }
        }
      };
      // Note: any trailing partial line without a final newline is
      // intentionally dropped from line-by-line callbacks; it is rare for
      // CLI tools and not load-bearing for the tail/message capture.
    }

    child.stdout.on('data', handleChunk('stdout'));
    child.stderr.on('data', handleChunk('stderr'));

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      resolve({ code: code ?? -1, tail: tailLines.join('\n') });
    });
  });
}

/**
 * Resolves the digest a container's image was created from, for use
 * before/after an update. Re-inspects the container fresh (does not reuse
 * a stale inspect object) so it reflects the current state.
 *
 * @param {string} name
 * @returns {Promise<string|null>}
 */
async function currentDigestForContainerName(name) {
  let inspectData;
  try {
    inspectData = await docker.getContainer(name).inspect();
  } catch (err) {
    console.warn(`docker.js: failed to inspect ${name} for digest resolution: ${err.message}`);
    return null;
  }
  const image = inspectData.Config?.Image;
  if (!image) return null;
  return resolveCurrentDigest(inspectData.Image, image);
}

/**
 * True when two JSON-ish values are structurally equal (arrays/objects/
 * primitives, as Docker inspect returns them). null and undefined are equal.
 */
function sameValue(a, b) {
  if (a == null && b == null) return true;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Pure: container create options that recreate `inspectData`'s container from
 * `targetImage`, keeping only what the user configured and letting the target
 * image supply its own defaults.
 *
 * A container's inspected Config is the *merge* of the old image's defaults and
 * the user's overrides. Copying it verbatim onto a new image would pin the old
 * image's ENV (e.g. APP_VERSION, PATH), CMD/ENTRYPOINT, labels and volumes
 * over the new image's — so anything identical to `baseImageConfig` (the image
 * the container currently runs) is dropped and left to the target image.
 * Also carries anonymous volumes over by name (their data would otherwise be
 * orphaned) and keeps a user-set hostname.
 *
 * @param {object} inspectData - container inspect output.
 * @param {object|null} baseImageConfig - `Config` of the image it runs now.
 * @param {string} targetImage - image ref/ID to create from.
 * @returns {object} options for `docker.createContainer` (without `name`).
 */
export function buildRecreateOptions(inspectData, baseImageConfig, targetImage) {
  const cfg = inspectData.Config || {};
  const base = baseImageConfig || {};
  const unlessDefault = (key) => (sameValue(cfg[key], base[key]) ? undefined : cfg[key]);

  const baseEnv = new Set(base.Env || []);
  const env = (cfg.Env || []).filter((e) => !baseEnv.has(e));

  const baseLabels = base.Labels || {};
  const labels = {};
  for (const [k, v] of Object.entries(cfg.Labels || {})) {
    if (baseLabels[k] !== v) labels[k] = v;
  }

  const minusBase = (obj, baseObj) => {
    const out = {};
    for (const k of Object.keys(obj || {})) {
      if (!baseObj || !(k in baseObj)) out[k] = obj[k];
    }
    return Object.keys(out).length ? out : undefined;
  };

  // Docker's default hostname is the short container ID; only a hostname the
  // user set (`hostname:` / --hostname) should survive into the new container.
  const defaultHostname = (inspectData.Id || '').slice(0, 12);
  const hostname = cfg.Hostname && cfg.Hostname !== defaultHostname ? cfg.Hostname : undefined;

  // Re-attach anonymous volumes (64-hex names) by name so their data follows
  // the container. Skip destinations the user already mounts explicitly.
  const hostConfig = { ...(inspectData.HostConfig || {}) };
  const covered = new Set([
    ...(hostConfig.Binds || []).map((b) => b.split(':')[1]).filter(Boolean),
    ...(hostConfig.Mounts || []).map((m) => m.Target).filter(Boolean),
  ]);
  const anonBinds = (inspectData.Mounts || [])
    .filter((m) => m.Type === 'volume' && /^[0-9a-f]{64}$/.test(m.Name || '') && !covered.has(m.Destination))
    .map((m) => `${m.Name}:${m.Destination}${m.RW === false ? ':ro' : ''}`);
  if (anonBinds.length) hostConfig.Binds = [...(hostConfig.Binds || []), ...anonBinds];

  // Keep only the user-meaningful endpoint settings; runtime state (IPs,
  // endpoint/network IDs, the old container's ID alias) must not be replayed.
  const shortId = defaultHostname;
  const endpoints = {};
  for (const [net, ep] of Object.entries(inspectData.NetworkSettings?.Networks || {})) {
    const aliases = (ep?.Aliases || []).filter((a) => a !== shortId);
    endpoints[net] = {
      ...(ep?.IPAMConfig ? { IPAMConfig: ep.IPAMConfig } : {}),
      ...(ep?.Links ? { Links: ep.Links } : {}),
      ...(aliases.length ? { Aliases: aliases } : {}),
      ...(ep?.DriverOpts ? { DriverOpts: ep.DriverOpts } : {}),
    };
  }

  const opts = {
    Image: targetImage,
    Hostname: hostname,
    Domainname: cfg.Domainname || undefined,
    Cmd: unlessDefault('Cmd'),
    Entrypoint: unlessDefault('Entrypoint'),
    Env: env,
    Labels: labels,
    ExposedPorts: minusBase(cfg.ExposedPorts, base.ExposedPorts),
    Volumes: minusBase(cfg.Volumes, base.Volumes),
    WorkingDir: unlessDefault('WorkingDir'),
    User: unlessDefault('User'),
    Healthcheck: unlessDefault('Healthcheck'),
    StopSignal: unlessDefault('StopSignal'),
    StopTimeout: cfg.StopTimeout,
    Tty: cfg.Tty,
    OpenStdin: cfg.OpenStdin,
    HostConfig: hostConfig,
    NetworkingConfig: { EndpointsConfig: endpoints },
  };
  for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
  return opts;
}

async function imageConfigOf(imageId) {
  try {
    return (await docker.getImage(imageId).inspect())?.Config || null;
  } catch {
    return null;
  }
}

/**
 * Replace a container with a new one built from `createOpts`, without ever
 * leaving the user with nothing: the old container is stopped and renamed out
 * of the way (not removed) until the new one has been created and started. On
 * any failure the new container is discarded and the old one is renamed back
 * and restarted. The old one is only removed once the new one is running.
 *
 * @param {{ start?: boolean }} [opts] - start the new container (defaults to
 *   whether the old one was running).
 * @returns {Promise<void>} throws (after rolling back) if the swap failed.
 */
async function replaceContainer(name, inspectData, createOpts, log, opts = {}) {
  const old = docker.getContainer(inspectData.Id);
  const wasRunning = inspectData.State?.Running === true;
  const start = opts.start ?? wasRunning;
  const backupName = `${name}-dockpull-old-${Date.now()}`;

  if (wasRunning) {
    try {
      await old.stop();
    } catch (err) {
      if (err.statusCode !== 304) throw err; // 304: already stopped
    }
  }

  // Rename the old container out of the way. An --rm (AutoRemove) container
  // is already gone once stopped — then there's nothing to fall back to.
  let backedUp = false;
  try {
    await old.rename({ name: backupName });
    backedUp = true;
  } catch (err) {
    if (err.statusCode !== 404) throw err;
  }

  let created = null;
  try {
    created = await docker.createContainer({ name, ...createOpts });
    if (start) await created.start();
  } catch (err) {
    if (backedUp) {
      log?.(`Recreate failed (${err.message}); restoring the previous container…`);
      try {
        if (created) await created.remove({ force: true });
        await old.rename({ name });
        if (wasRunning) await old.start();
        log?.('Previous container restored.');
      } catch (restoreErr) {
        log?.(`Could not restore the previous container (kept as "${backupName}"): ${restoreErr.message}`);
      }
    }
    throw err;
  }

  if (backedUp) {
    try {
      await old.remove();
    } catch (err) {
      console.warn(`docker.js: couldn't remove old container ${backupName}: ${err.message}`);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll a container after an update to confirm it actually comes up, so we don't
 * report a green "updated" for an image that immediately crash-loops. Returns
 * as soon as the state is decisive; gives up (unhealthy) after `timeoutMs`.
 *
 * @param {string} name
 * @returns {Promise<{ healthy: boolean, state: string, health: string|null, timedOut?: boolean }>}
 */
export async function verifyContainerHealth(name, { timeoutMs = 30000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let state = 'unknown';
  let health = null;
  for (;;) {
    let data;
    try {
      data = await docker.getContainer(name).inspect();
    } catch {
      return { healthy: false, state: 'missing', health: null };
    }
    state = data.State?.Status || 'unknown';
    health = data.State?.Health?.Status || null; // healthy|unhealthy|starting|null
    if (state === 'running') {
      if (!health || health === 'healthy') return { healthy: true, state, health };
      if (health === 'unhealthy') return { healthy: false, state, health };
      // 'starting' — healthcheck still warming up; keep waiting.
    } else if (state === 'exited' || state === 'dead') {
      return { healthy: false, state, health };
    }
    // restarting / created / paused — keep polling until decisive or timeout.
    if (Date.now() >= deadline) return { healthy: false, state, health, timedOut: true };
    await sleep(intervalMs);
  }
}

/** Human phrase for an unhealthy verification result. */
function describeUnhealthy(h) {
  if (h.state === 'missing') return 'the container disappeared';
  if (h.health === 'unhealthy') return 'its healthcheck is failing';
  if (h.state === 'restarting') return 'it keeps restarting (likely a crash loop)';
  if (h.state === 'exited' || h.state === 'dead') return 'it exited right after starting';
  if (h.timedOut) return `it didn't become healthy in time (state: ${h.state}${h.health ? `/${h.health}` : ''})`;
  return `it isn't running (state: ${h.state})`;
}

/**
 * Wrap a successful update result with a post-update health check. If the
 * container doesn't come up healthy, downgrade to a failure with an actionable
 * message (the new image is recorded so the user can revert).
 */
async function withHealthCheck(name, result, expectRunning) {
  if (!result.success || !expectRunning) return result;
  const h = await verifyContainerHealth(name);
  if (h.healthy) return { ...result, healthy: true, healthState: h.state };
  return {
    ...result,
    success: false,
    healthy: false,
    healthState: h.state,
    message: `Image updated, but ${describeUnhealthy(h)}. The new version may be broken — check the logs, or revert to the previous version.`,
  };
}

/**
 * Updates a container: prefers compose-based update (pull + up -d via the
 * `docker compose` CLI) when compose labels are present; otherwise falls
 * back to a standalone docker pull + recreate using dockerode, preserving
 * the container's existing Config/HostConfig/name.
 *
 * Does not write to the DB — the caller (WP3 API layer) is responsible for
 * recording history.
 *
 * @param {string} name - container name.
 * @param {(line: string, stream: 'stdout'|'stderr') => void} [onLine]
 * @returns {Promise<{ success: boolean, message: string, oldDigest: string|null, newDigest: string|null }>}
 */
export async function updateContainer(name, onLine) {
  let inspectData;
  try {
    inspectData = await docker.getContainer(name).inspect();
  } catch (err) {
    return {
      success: false,
      message: `Container "${name}" not found or could not be inspected: ${err.message}`,
      oldDigest: null,
      newDigest: null,
    };
  }

  const image = inspectData.Config?.Image;
  const oldDigest = image ? await resolveCurrentDigest(inspectData.Image, image) : null;
  // Local image ID of what's running now, so a later revert can recreate the
  // container from this exact (working) image without pulling.
  const oldImageId = inspectData.Image || null;
  const composeInfo = await getComposeInfo(inspectData);

  const isComposeManaged = Boolean(composeInfo?.composeFile && composeInfo?.service);

  if (isComposeManaged) {
    const { composeFile, workingDir, service } = composeInfo;

    // The `docker compose` CLI runs inside THIS container but reads the
    // compose file from this container's filesystem. If the stacks dir isn't
    // mounted here at the same absolute path it has on the host, the file
    // won't exist and compose fails with a cryptic "no such file" error.
    // Catch it up front with an actionable message — and suggest the mount
    // derived from THIS compose file's own location (the dir above the stack
    // folder), not config.STACKS_DIR, which may be set to the wrong path.
    if (!fs.existsSync(composeFile)) {
      const stacksRoot = path.dirname(path.dirname(composeFile));
      return {
        success: false,
        message:
          `Compose file not found at "${composeFile}" inside the updater container. ` +
          `The directory holding your stacks must be bind-mounted at the SAME ` +
          `absolute path on the host and in this container — add ` +
          `"${stacksRoot}:${stacksRoot}" to this container's volumes (and set ` +
          `STACKS_DIR=${stacksRoot}). See the README "same-path mount" note.`,
        oldDigest,
        newDigest: null,
      };
    }

    const baseArgs = ['compose', '-f', composeFile, '--project-directory', workingDir];

    let pullResult;
    try {
      pullResult = await spawnAndStream('docker', [...baseArgs, 'pull', service], onLine);
    } catch (err) {
      return {
        success: false,
        message: `Failed to start "docker compose pull": ${err.message}`,
        oldDigest,
        newDigest: null,
      };
    }

    if (pullResult.code !== 0) {
      return {
        success: false,
        message: `docker compose pull failed (exit ${pullResult.code}):\n${pullResult.tail}`,
        oldDigest,
        newDigest: null,
      };
    }

    let upResult;
    try {
      upResult = await spawnAndStream('docker', [...baseArgs, 'up', '-d', service], onLine);
    } catch (err) {
      return {
        success: false,
        message: `Failed to start "docker compose up -d": ${err.message}`,
        oldDigest,
        newDigest: null,
      };
    }

    if (upResult.code !== 0) {
      return {
        success: false,
        message: `docker compose up -d failed (exit ${upResult.code}):\n${upResult.tail}`,
        oldDigest,
        newDigest: null,
      };
    }

    const newDigest = await currentDigestForContainerName(name);
    return withHealthCheck(
      name,
      { success: true, message: 'Updated successfully via docker compose.', oldDigest, newDigest, oldImageId },
      true
    );
  }

  // Standalone fallback: docker pull + recreate via dockerode, preserving
  // the existing Config/HostConfig/name. Best-effort: does not handle
  // every edge case (e.g. containers in a network with custom aliases,
  // anonymous volumes that should be reused, etc.) — see module-level
  // docs / WP1 report for limitations.
  if (!image) {
    return {
      success: false,
      message: `Container "${name}" has no configured image; cannot update.`,
      oldDigest,
      newDigest: null,
    };
  }

  let pullResult;
  try {
    pullResult = await spawnAndStream('docker', ['pull', image], onLine);
  } catch (err) {
    return {
      success: false,
      message: `Failed to start "docker pull": ${err.message}`,
      oldDigest,
      newDigest: null,
    };
  }

  if (pullResult.code !== 0) {
    return {
      success: false,
      message: `docker pull failed (exit ${pullResult.code}):\n${pullResult.tail}`,
      oldDigest,
      newDigest: null,
    };
  }

  const wasRunning = inspectData.State?.Running === true;
  try {
    const baseImageConfig = await imageConfigOf(inspectData.Image);
    const createOpts = buildRecreateOptions(inspectData, baseImageConfig, image);
    await replaceContainer(name, inspectData, createOpts, (l) => onLine?.(l, 'stdout'));
  } catch (err) {
    return {
      success: false,
      message: `Pulled new image but failed to recreate container: ${err.message}`,
      oldDigest,
      newDigest: null,
    };
  }

  const newDigest = await currentDigestForContainerName(name);
  return withHealthCheck(
    name,
    {
      success: true,
      message: 'Updated successfully via standalone docker pull + recreate.',
      oldDigest,
      newDigest,
      oldImageId,
    },
    wasRunning
  );
}

/**
 * Revert a container to a previous local image by ID: recreate it from that
 * image (no pull), preserving its config/host config/networks, and start it.
 * Works for both compose- and standalone-managed containers (it manipulates
 * the container directly). The container is left off its compose-tracked tag,
 * so a later `docker compose up` will move it forward again — callers should
 * tell the user to pin the version until they're ready.
 *
 * @param {string} name
 * @param {string} imageId - local image ID/ref to recreate from.
 * @param {(line: string, stream: 'stdout'|'stderr') => void} [onLine]
 * @returns {Promise<{ success: boolean, message: string, oldDigest: string|null, newDigest: string|null }>}
 */
export async function revertContainer(name, imageId, onLine) {
  const log = (line) => onLine && onLine(line, 'stdout');
  let inspectData;
  try {
    inspectData = await docker.getContainer(name).inspect();
  } catch (err) {
    return { success: false, message: `Container "${name}" not found: ${err.message}`, oldDigest: null, newDigest: null };
  }

  const oldDigest = await currentDigestForContainerName(name);

  try {
    log(`Reverting "${name}" to the previous image…`);
    const baseImageConfig = await imageConfigOf(inspectData.Image);
    const createOpts = buildRecreateOptions(inspectData, baseImageConfig, imageId);
    // Revert always starts the container, even if it was stopped.
    await replaceContainer(name, inspectData, createOpts, log, { start: true });
    log('Container recreated from the previous image.');
  } catch (err) {
    return { success: false, message: `Failed to revert container: ${err.message}`, oldDigest, newDigest: null };
  }

  const newDigest = await currentDigestForContainerName(name);
  const health = await verifyContainerHealth(name);
  if (!health.healthy) {
    return { success: false, message: `Reverted, but ${describeUnhealthy(health)}.`, oldDigest, newDigest };
  }
  return { success: true, message: 'Reverted to the previous image.', oldDigest, newDigest };
}

/**
 * Lightweight per-container image metadata for the changelog endpoint:
 * the configured image ref plus its OCI version + source labels.
 *
 * @param {string} name
 * @returns {Promise<{ image: string|null, currentVersion: string|null, sourceUrl: string|null }>}
 */
export async function getContainerImageMeta(name) {
  const inspectData = await docker.getContainer(name).inspect();
  const image = inspectData.Config?.Image || null;
  if (!image) return { image: null, currentVersion: null, sourceUrl: null };
  const { version, source } = await inspectImageMeta(inspectData.Image, image);
  return { image, currentVersion: version, sourceUrl: source };
}

/**
 * Normalizes a Docker image ID (`sha256:<64-hex>` or already-short) down to
 * the 12-char short form used for display and for matching a dangling image
 * back to the rollback point that recorded it (see routes/api.js).
 *
 * @param {string} id
 * @returns {string}
 */
export function shortImageId(id) {
  return (id || '').replace(/^sha256:/, '').slice(0, 12);
}

/**
 * List dangling images (untagged layers no container references) without
 * deleting anything — a dry-run preview for the prune confirmation dialog,
 * so the user knows what they're about to remove before they remove it.
 *
 * @returns {Promise<{ count: number, totalSize: number, images: Array<{ id: string, size: number, created: number }> }>}
 */
export async function listDanglingImages() {
  const images = await docker.listImages({ filters: { dangling: ['true'] } });
  const list = images.map((img) => ({
    id: shortImageId(img.Id),
    size: img.Size ?? 0,
    created: img.Created ?? null,
  }));
  return {
    count: list.length,
    totalSize: list.reduce((sum, img) => sum + img.size, 0),
    images: list,
  };
}

/**
 * Remove dangling images (untagged layers no container references) —
 * the leftovers that accumulate after image updates. Safe: never touches
 * tagged images or anything in use.
 *
 * @returns {Promise<{ deleted: number, spaceReclaimed: number }>}
 */
export async function pruneDanglingImages() {
  // dockerode serializes the filters object into the API's JSON filter param.
  const result = await docker.pruneImages({ filters: { dangling: ['true'] } });
  return {
    deleted: result.ImagesDeleted?.length ?? 0,
    spaceReclaimed: result.SpaceReclaimed ?? 0,
  };
}

/**
 * Remove only the specified dangling images (by short ID), leaving any the
 * user excluded from the prune in place. Re-lists dangling images and removes
 * exclusively those that are BOTH still dangling AND in the requested set —
 * so a tagged/in-use image can never be caught even if a stale ID is passed,
 * and images that stopped being dangling since the preview are skipped.
 * Removals are best-effort per image: one failure is logged and doesn't abort
 * the rest.
 *
 * @param {string[]} ids - short (12-char) image IDs to remove.
 * @returns {Promise<{ deleted: number, spaceReclaimed: number }>}
 */
export async function removeDanglingImages(ids) {
  const wanted = new Set((ids || []).map(shortImageId));
  if (wanted.size === 0) return { deleted: 0, spaceReclaimed: 0 };

  const images = await docker.listImages({ filters: { dangling: ['true'] } });
  let deleted = 0;
  let spaceReclaimed = 0;
  for (const img of images) {
    if (!wanted.has(shortImageId(img.Id))) continue;
    try {
      await docker.getImage(img.Id).remove();
      deleted += 1;
      spaceReclaimed += img.Size ?? 0;
    } catch (err) {
      console.warn(`docker.js: failed to remove image ${shortImageId(img.Id)}: ${err.message}`);
    }
  }
  return { deleted, spaceReclaimed };
}

export { docker };
