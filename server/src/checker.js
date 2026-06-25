/**
 * Active update check: for each running container, ask the registry for the
 * current digest of its tag and reconcile against what's running — recording
 * an update event when they differ, or resolving stale events when they match.
 *
 * This is the app's sole source of update information: it queries each image's
 * registry directly, with no dependency on any external notifier.
 */

import { listContainers } from './docker.js';
import { getRemoteDigest } from './registry.js';
import { digestsEqual } from './reconcile.js';
import * as db from './db.js';

const CONCURRENCY = 4;

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
          continue;
        }

        // Differs from what's running: flag it, unless we already have an
        // unresolved event for this exact digest (avoid duplicate rows on
        // repeated checks).
        const existing = db.latestUnresolvedEventForRef(c.normalizedRef);
        if (existing && digestsEqual(existing.digest, remote)) continue;

        db.recordEvent({
          image: c.image,
          normalized_ref: c.normalizedRef,
          status: 'update',
          digest: remote,
          raw_json: JSON.stringify({ source: 'check' }),
        });
        updatesFound += 1;
      } catch (err) {
        errors += 1;
        console.warn(`checker: failed to check ${c.image}: ${err.message}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker())
  );

  return { total: items.length, checked, updatesFound, errors };
}

export default { runCheck };
