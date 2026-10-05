/**
 * Active update check: for each running container, ask the registry for the
 * current digest of its tag and reconcile against what's running — recording
 * an update event when they differ, or resolving stale events when they match.
 *
 * This is the app's sole source of update information: it queries each image's
 * registry directly, with no dependency on any external notifier.
 */

import { listContainers } from './docker.js';
import { getRemoteDigest, getRemoteVersion, listTags } from './registry.js';
import { digestsEqual, isRunningDigest } from './reconcile.js';
import { isMeaningfulVersion, parseVersionTag, findNewerTags } from './version.js';
import { parseRef } from './reconcile.js';
import { getSettings } from './settings.js';
import {
  parseGitHubRepo,
  getLatestReleaseTag,
  getReleasesCached,
  selectNewerReleases,
  detectBreakingChanges,
} from './changelog.js';
import * as db from './db.js';

const CONCURRENCY = 4;

/**
 * Best-effort human version for the AVAILABLE image. Prefer the image's own
 * `org.opencontainers.image.version` label; if that isn't a usable version
 * (e.g. `main`, `latest`, a sha) but the image declares a GitHub source, fall
 * back to that repo's latest release tag (cached). Returns null if nothing
 * meaningful is found.
 *
 * @param {{ image: string, sourceUrl?: string|null }} c
 * @returns {Promise<string|null>}
 */
async function resolveAvailableVersion(c) {
  const labelVersion = await getRemoteVersion(c.image);
  if (isMeaningfulVersion(labelVersion)) return labelVersion;

  const gh = parseGitHubRepo(c.sourceUrl);
  if (gh) {
    const tag = await getLatestReleaseTag(gh.owner, gh.repo);
    if (isMeaningfulVersion(tag)) return tag;
  }
  return labelVersion || null;
}

/**
 * The running image's latest release tag, when its own version label is junk
 * but it declares a GitHub source. Cached. Used for up-to-date images, where
 * "running" == the latest release.
 *
 * @param {{ sourceUrl?: string|null }} c
 * @returns {Promise<string|null>}
 */
async function releaseTagForSource(c) {
  const gh = parseGitHubRepo(c.sourceUrl);
  if (!gh) return null;
  const tag = await getLatestReleaseTag(gh.owner, gh.repo);
  return isMeaningfulVersion(tag) ? tag : null;
}

/**
 * Best-effort breaking-change scan for a container with a GitHub source:
 * check the release notes between the running version and the newest release
 * for breaking-change signals. Any failure means 0 — never fails the check.
 *
 * @param {{ sourceUrl?: string|null, currentVersion?: string|null }} c
 * @returns {Promise<0|1>}
 */
async function detectBreakingForContainer(c) {
  try {
    const gh = parseGitHubRepo(c.sourceUrl);
    if (!gh) return 0;
    const releases = await getReleasesCached(gh.owner, gh.repo);
    // Without a known running version we can't tell which notes are "newer",
    // and scanning the latest few releases wholesale over-flags.
    if (!isMeaningfulVersion(c.currentVersion)) return 0;
    const newer = selectNewerReleases(releases, c.currentVersion);
    return detectBreakingChanges(newer) ? 1 : 0;
  } catch {
    return 0;
  }
}

// The in-flight check, if any. A manual "Check for updates" and the daily scan
// (or two open dashboards auto-checking) can overlap; running two checks at
// once would race on the "already flagged?" lookup and insert duplicate events,
// so concurrent callers share the one run instead.
let inFlight = null;

/**
 * @returns {Promise<{ total: number, checked: number, updatesFound: number, errors: number }>}
 * @throws if the Docker daemon can't be reached (caller maps to 503).
 */
export function runCheck() {
  if (!inFlight) {
    inFlight = doCheck().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function doCheck() {
  const containers = await listContainers();

  // Group by normalized ref so we hit each registry tag once even if several
  // containers run it — but keep every container, since they may be running
  // different images of that tag (one recreated, another not). Containers with
  // no registry digest (built locally, loaded from a tarball) have nothing to
  // compare against, so they're counted as checked without a registry call.
  const byRef = new Map();
  const noDigestRefs = new Set();
  for (const c of containers) {
    if (!c.currentDigest) {
      noDigestRefs.add(c.normalizedRef);
      continue;
    }
    if (!byRef.has(c.normalizedRef)) byRef.set(c.normalizedRef, []);
    byRef.get(c.normalizedRef).push(c);
  }
  const items = [...byRef.values()];
  const unverifiable = [...noDigestRefs].filter((ref) => !byRef.has(ref)).length;

  let checked = unverifiable;
  let updatesFound = 0;
  let errors = 0;
  const errored = []; // { ref, image, message } per failed container check

  // Newer-tag detection: one tag listing per repository per check, shared by
  // every tag of it that's running. Best-effort — a failure here never counts
  // as a check error (the digest check above is what matters).
  const tagPolicy = getSettings().tagUpdates;
  const tagListCache = new Map();
  async function checkNewerTags(c) {
    if (tagPolicy === 'off') return;
    let parsed;
    try {
      parsed = parseRef(c.image);
    } catch {
      return;
    }
    if (!parsed.tag || !parseVersionTag(parsed.tag)) {
      db.setTagUpdate({ normalized_ref: c.normalizedRef, current_tag: parsed.tag || '' }); // clears any stale row
      return;
    }
    const repoKey = `${parsed.registry}/${parsed.repository}`;
    if (!tagListCache.has(repoKey)) tagListCache.set(repoKey, listTags(c.image).catch((err) => err));
    const tags = await tagListCache.get(repoKey);
    if (tags instanceof Error) {
      console.warn(`checker: couldn't list tags for ${repoKey}: ${tags.message}`);
      return;
    }
    const { sameMajor, nextMajor } = findNewerTags(parsed.tag, tags);
    db.setTagUpdate({
      normalized_ref: c.normalizedRef,
      current_tag: parsed.tag,
      same_major: sameMajor,
      next_major: nextMajor,
    });
  }

  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const group = items[idx];
      idx += 1;
      let c = group[0];
      try {
        await checkNewerTags(c);
      } catch (err) {
        console.warn(`checker: tag check failed for ${c.image}: ${err.message}`);
      }
      try {
        const remote = await getRemoteDigest(c.image);
        checked += 1;
        if (!remote) continue; // digest-pinned or registry gave no digest

        const stale = group.filter((x) => !isRunningDigest(remote, x.currentDigest, x.currentDigests));
        if (stale.length === 0) {
          // Up to date — clear any stale unresolved event.
          db.resolveEventsForRef(c.normalizedRef);
          // The running image IS the latest. If its own version label is junk
          // (e.g. homarr's `main`), remember the source repo's latest release
          // tag for this digest so the dashboard can show a real number.
          if (!isMeaningfulVersion(c.currentVersion)) {
            const tag = await releaseTagForSource(c);
            if (tag) db.setImageVersion(c.currentDigest, tag);
          } else {
            // Remember the running version for this digest too, so update
            // history can show "old version → new version" after it's replaced.
            db.setImageVersion(c.currentDigest, c.currentVersion);
          }
          continue;
        }
        c = stale[0];

        // Differs from what's running: flag it, unless we already have an
        // unresolved event for this exact digest (avoid duplicate rows on
        // repeated checks).
        const existing = db.latestUnresolvedEventForRef(c.normalizedRef);
        if (existing && digestsEqual(existing.digest, remote)) {
          // Already flagged. If we previously stored a junk version label
          // (e.g. "main"), try to backfill a real one now without waiting for
          // a new image to appear.
          if (!isMeaningfulVersion(existing.available_version)) {
            const better = await resolveAvailableVersion(c);
            if (isMeaningfulVersion(better)) {
              db.updateEventAvailableVersion(c.normalizedRef, remote, better);
              db.setImageVersion(remote, better);
            }
          }
          continue;
        }

        // Best-effort: only paid for images that actually have an update.
        const availableVersion = await resolveAvailableVersion(c);
        // Scan release notes from what's actually running: prefer the image's
        // own label, else a version remembered for its digest, so a junk label
        // (`main`) doesn't make every recent release count as "newer".
        const runningVersion = isMeaningfulVersion(c.currentVersion)
          ? c.currentVersion
          : db.getImageVersion(c.currentDigest);
        const breaking = await detectBreakingForContainer({ ...c, currentVersion: runningVersion });

        db.recordEvent({
          image: c.image,
          normalized_ref: c.normalizedRef,
          status: 'update',
          digest: remote,
          available_version: availableVersion,
          breaking,
          raw_json: JSON.stringify({ source: 'check' }),
        });
        // Remember versions per digest: the available one keyed by the remote
        // digest (so it shows instantly once the user updates), and the running
        // one if its own label is usable.
        if (isMeaningfulVersion(availableVersion)) db.setImageVersion(remote, availableVersion);
        if (isMeaningfulVersion(c.currentVersion)) db.setImageVersion(c.currentDigest, c.currentVersion);
        updatesFound += 1;
      } catch (err) {
        errors += 1;
        errored.push({ ref: c.normalizedRef, image: c.image, message: err.message });
        console.warn(`checker: failed to check ${c.image}: ${err.message}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker())
  );

  const total = items.length + unverifiable;
  const summary = { at: Date.now(), total, checked, updatesFound, errors, errored };
  try {
    db.setMeta('lastCheck', summary);
  } catch {
    // metadata persistence is best-effort; never fail a check over it.
  }

  return { total, checked, updatesFound, errors };
}

export default { runCheck };
