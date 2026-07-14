/**
 * Active update check: for each running container, ask the registry for the
 * current digest of its tag and reconcile against what's running — recording
 * an update event when they differ, or resolving stale events when they match.
 *
 * This is the app's sole source of update information: it queries each image's
 * registry directly, with no dependency on any external notifier.
 */

import { listContainers } from './docker.js';
import { getRemoteDigest, getRemoteVersion } from './registry.js';
import { digestsEqual } from './reconcile.js';
import { isMeaningfulVersion } from './version.js';
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
    const newer = selectNewerReleases(releases, c.currentVersion);
    return detectBreakingChanges(newer) ? 1 : 0;
  } catch {
    return 0;
  }
}

/**
 * @returns {Promise<{ total: number, checked: number, updatesFound: number, errors: number }>}
 * @throws if the Docker daemon can't be reached (caller maps to 503).
 */
export async function runCheck() {
  const containers = await listContainers();

  // De-dupe by normalized ref so we hit each image once even if several
  // containers run it.
  const byRef = new Map();
  for (const c of containers) {
    if (!byRef.has(c.normalizedRef)) byRef.set(c.normalizedRef, c);
  }
  const items = [...byRef.values()];

  let checked = 0;
  let updatesFound = 0;
  let errors = 0;
  const errored = []; // { ref, image, message } per failed container check

  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const c = items[idx];
      idx += 1;
      try {
        const remote = await getRemoteDigest(c.image);
        checked += 1;
        if (!remote) continue; // digest-pinned or registry gave no digest

        if (c.currentDigest && digestsEqual(remote, c.currentDigest)) {
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
        const breaking = await detectBreakingForContainer(c);

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

  const summary = { at: Date.now(), total: items.length, checked, updatesFound, errors, errored };
  try {
    db.setMeta('lastCheck', summary);
  } catch {
    // metadata persistence is best-effort; never fail a check over it.
  }

  return { total: items.length, checked, updatesFound, errors };
}

export default { runCheck };
