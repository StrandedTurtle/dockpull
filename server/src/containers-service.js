/**
 * Pure reconciliation merge: combines docker.js's listContainers() output
 * with the latest unresolved update event (per normalized ref) and pin state
 * to produce the API item shape documented in API_CONTRACT.md under
 * "/api/containers item shape".
 *
 * Deliberately free of DB/dockerode imports — callers inject `lookupEvent`
 * and `isPinned` so this is trivially unit-testable (see
 * server/test/containers-service.test.js).
 */

import { isUpdateAvailable, digestsEqual } from './reconcile.js';

/**
 * @param {object} params
 * @param {Array<{
 *   name: string, image: string, currentDigest: string|null,
 *   project: string|null, service: string|null, composeFile: string|null,
 *   workingDir: string|null, state: string, normalizedRef: string
 * }>} params.containers - docker.js listContainers() output.
 * @param {(normalizedRef: string) => ({digest: string|null}|undefined)} params.lookupEvent
 *   - returns the latest unresolved event row for a normalized ref, or
 *     undefined if there is none.
 * @param {(normalizedRef: string) => boolean} params.isPinned
 * @returns {{
 *   items: Array<object>,
 *   refsToResolve: string[]
 * }}
 */
export function buildContainerItems({ containers, lookupEvent, isPinned }) {
  const items = [];
  const refsToResolve = [];

  for (const c of containers) {
    const event = lookupEvent(c.normalizedRef);

    let updateAvailable;
    let availableDigest;

    if (event && digestsEqual(c.currentDigest, event.digest)) {
      // The running container's digest already matches the event's digest:
      // the update has already been applied. Mark the event resolved and
      // report no update available.
      refsToResolve.push(c.normalizedRef);
      updateAvailable = false;
      availableDigest = null;
    } else {
      updateAvailable = isUpdateAvailable(c.currentDigest, event?.digest);
      availableDigest = updateAvailable ? event.digest : null;
    }

    items.push({
      name: c.name,
      project: c.project,
      service: c.service,
      image: c.image,
      tag: c.tag ?? null,
      currentVersion: c.currentVersion ?? null,
      sourceUrl: c.sourceUrl ?? null,
      currentDigest: c.currentDigest,
      updateAvailable,
      availableDigest,
      pinned: isPinned(c.normalizedRef),
      state: c.state,
      composeFile: c.composeFile,
      composeFileMissing: c.composeFileMissing ?? false,
      workingDir: c.workingDir,
    });
  }

  return { items, refsToResolve };
}

export default buildContainerItems;
