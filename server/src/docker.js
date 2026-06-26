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
 * Pure: picks the digest from an image's `RepoDigests` that matches the
 * configured image ref's repo, to disambiguate when an image was pulled/
 * tagged under several refs. Falls back to the sole RepoDigest if there's
 * exactly one. Returns null when there's no usable match.
 *
 * @param {string[]|undefined} repoDigests - image inspect `RepoDigests`.
 * @param {string} image - configured image ref, e.g. "nginx:latest".
 * @returns {string|null}
 */
function pickRepoDigest(repoDigests, image) {
  if (!Array.isArray(repoDigests) || repoDigests.length === 0) {
    return null;
  }

  // Determine the repo (registry/repo, no tag) we're looking for.
  let wantedRepo = null;
  try {
    const normalized = normalizeRef(image);
    wantedRepo = normalized.includes(':')
      ? normalized.slice(0, normalized.lastIndexOf(':'))
      : normalized;
  } catch {
    wantedRepo = null;
  }

  if (wantedRepo) {
    for (const entry of repoDigests) {
      const atIdx = entry.lastIndexOf('@');
      if (atIdx === -1) continue;
      const repoPart = entry.slice(0, atIdx);
      let normalizedRepoPart;
      try {
        // Append a dummy tag so normalizeRef parses repoPart as a name,
        // not as "repo:port"-style ambiguity; we only need the
        // registry/repo portion back out.
        const probe = normalizeRef(`${repoPart}:__probe__`);
        normalizedRepoPart = probe.slice(0, probe.lastIndexOf(':'));
      } catch {
        normalizedRepoPart = repoPart;
      }
      if (normalizedRepoPart === wantedRepo) {
        return entry.slice(atIdx + 1);
      }
    }
  }

  // No repo match found; fall back to the sole RepoDigest's digest part, but
  // only if there's exactly one (otherwise it's ambiguous which applies).
  if (repoDigests.length === 1) {
    const atIdx = repoDigests[0].lastIndexOf('@');
    return atIdx === -1 ? null : repoDigests[0].slice(atIdx + 1);
  }

  return null;
}

/**
 * Inspects an image once and returns both the running digest (matched to the
 * configured ref) and the human-readable version from the
 * `org.opencontainers.image.version` label, if the image sets it. Returns
 * nulls if the image can't be inspected.
 *
 * @param {string} imageIdOrName - `Image` field from container inspect.
 * @param {string} image - configured image ref, e.g. "nginx:latest".
 * @returns {Promise<{ digest: string|null, version: string|null }>}
 */
async function inspectImageMeta(imageIdOrName, image) {
  let imageInfo;
  try {
    imageInfo = await docker.getImage(imageIdOrName).inspect();
  } catch (err) {
    console.warn(`docker.js: failed to inspect image ${imageIdOrName}: ${err.message}`);
    return { digest: null, version: null };
  }

  const labels = imageInfo?.Config?.Labels || {};
  const version = labels['org.opencontainers.image.version'] || null;
  const source = normalizeSourceUrl(
    labels['org.opencontainers.image.source'] || labels['org.opencontainers.image.url'] || null
  );
  const digest = pickRepoDigest(imageInfo?.RepoDigests, image);
  return { digest, version, source };
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
    return {
      success: true,
      message: 'Updated successfully via docker compose.',
      oldDigest,
      newDigest,
    };
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

  try {
    const container = docker.getContainer(name);

    const wasRunning = inspectData.State?.Running === true;

    if (wasRunning) {
      await container.stop();
    }
    await container.remove();

    const created = await docker.createContainer({
      name,
      Image: inspectData.Config.Image,
      Cmd: inspectData.Config.Cmd,
      Entrypoint: inspectData.Config.Entrypoint,
      Env: inspectData.Config.Env,
      Labels: inspectData.Config.Labels,
      ExposedPorts: inspectData.Config.ExposedPorts,
      Volumes: inspectData.Config.Volumes,
      WorkingDir: inspectData.Config.WorkingDir,
      User: inspectData.Config.User,
      Tty: inspectData.Config.Tty,
      OpenStdin: inspectData.Config.OpenStdin,
      StopSignal: inspectData.Config.StopSignal,
      StopTimeout: inspectData.Config.StopTimeout,
      HostConfig: inspectData.HostConfig,
      NetworkingConfig: {
        EndpointsConfig: inspectData.NetworkSettings?.Networks,
      },
    });

    if (wasRunning) {
      await created.start();
    }
  } catch (err) {
    return {
      success: false,
      message: `Pulled new image but failed to recreate container: ${err.message}`,
      oldDigest,
      newDigest: null,
    };
  }

  const newDigest = await currentDigestForContainerName(name);
  return {
    success: true,
    message: 'Updated successfully via standalone docker pull + recreate.',
    oldDigest,
    newDigest,
  };
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

export { docker };
