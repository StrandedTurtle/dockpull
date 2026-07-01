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
import { isMeaningfulVersion } from './version.js';

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
 * @param {(digest: string|null) => (string|null)} [params.lookupVersion]
 *   - returns a remembered human version for an image digest, or null. Lets the
 *     dashboard show a real version even when the image's own labels are junk.
 * @returns {{
 *   items: Array<object>,
 *   refsToResolve: string[]
 * }}
 */
export function buildContainerItems({
  containers,
  lookupEvent,
  isPinned,
  lookupVersion = () => null,
  getRollback = () => null,
  getCheckError = () => null,
}) {
  const items = [];
  const refsToResolve = [];

  for (const c of containers) {
    const event = lookupEvent(c.normalizedRef);

    let updateAvailable;
    let availableDigest;
    let availableVersion;

    if (event && digestsEqual(c.currentDigest, event.digest)) {
      // The running container's digest already matches the event's digest:
      // the update has already been applied. Mark the event resolved and
      // report no update available.
      refsToResolve.push(c.normalizedRef);
      updateAvailable = false;
      availableDigest = null;
      availableVersion = null;
    } else {
      updateAvailable = isUpdateAvailable(c.currentDigest, event?.digest);
      availableDigest = updateAvailable ? event.digest : null;
      availableVersion = updateAvailable ? (event?.available_version ?? null) : null;
    }

    // Prefer the image's own meaningful version label; otherwise fall back to a
    // version we remembered for this digest from a prior check.
    const currentVersion = isMeaningfulVersion(c.currentVersion)
      ? c.currentVersion
      : lookupVersion(c.currentDigest) ?? c.currentVersion ?? null;
    if (updateAvailable && !isMeaningfulVersion(availableVersion)) {
      availableVersion = lookupVersion(availableDigest) ?? availableVersion ?? null;
    }

    const rollback = getRollback(c.name);

    items.push({
      name: c.name,
      project: c.project,
      service: c.service,
      image: c.image,
      tag: c.tag ?? null,
      currentVersion,
      sourceUrl: c.sourceUrl ?? null,
      currentDigest: c.currentDigest,
      updateAvailable,
      availableDigest,
      availableVersion,
      pinned: isPinned(c.normalizedRef),
      canRevert: !!rollback,
      rollbackVersion: rollback?.old_version ?? null,
      checkError: getCheckError(c.normalizedRef),
      state: c.state,
      composeFile: c.composeFile,
      composeFileMissing: c.composeFileMissing ?? false,
      workingDir: c.workingDir,
    });
  }

  return { items, refsToResolve };
}

export default buildContainerItems;
