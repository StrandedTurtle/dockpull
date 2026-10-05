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

import { isUpdateAvailable, isRunningDigest } from './reconcile.js';
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
  getTagUpdate = () => null,
  tagPolicy = 'minor',
}) {
  const items = [];
  const refsToResolve = [];

  for (const c of containers) {
    const event = lookupEvent(c.normalizedRef);

    let updateAvailable;
    let availableDigest;
    let availableVersion;
    let skipped = false;

    if (event && isRunningDigest(event.digest, c.currentDigest, c.currentDigests)) {
      // The running image is already known under the event's digest: the
      // update has been applied (or the "new" digest was just a re-pushed
      // index for the same image). Mark the event resolved and report no
      // update available.
      refsToResolve.push(c.normalizedRef);
      updateAvailable = false;
      availableDigest = null;
      availableVersion = null;
    } else {
      updateAvailable = isUpdateAvailable(c.currentDigest, event?.digest);
      availableDigest = updateAvailable ? event.digest : null;
      availableVersion = updateAvailable ? (event?.available_version ?? null) : null;
      // The user dismissed this exact build: not "available", but remember
      // what was skipped so the card can offer to undo it.
      if (updateAvailable && event?.skipped) {
        skipped = true;
        updateAvailable = false;
      }
    }

    // Prefer the image's own meaningful version label; otherwise fall back to a
    // version we remembered for this digest from a prior check.
    const currentVersion = isMeaningfulVersion(c.currentVersion)
      ? c.currentVersion
      : lookupVersion(c.currentDigest) ?? c.currentVersion ?? null;
    if ((updateAvailable || skipped) && !isMeaningfulVersion(availableVersion)) {
      availableVersion = lookupVersion(availableDigest) ?? availableVersion ?? null;
    }

    const rollback = getRollback(c.name);

    // Newer version tags (postgres:16.3 -> 16.4 / 17.1), minus a skipped one
    // and filtered by the "tag updates" setting.
    const tagRow = tagPolicy === 'off' ? null : getTagUpdate(c.normalizedRef);
    const visibleTag = (t) => (t && t !== tagRow?.dismissed_tag ? t : null);
    const newerTag = visibleTag(tagRow?.same_major);
    const newerMajorTag = tagPolicy === 'major' ? visibleTag(tagRow?.next_major) : null;

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
      // Only meaningful alongside an actual update — a stale event's flag
      // must not leak through once the digests match again.
      breakingRisk: !!(updateAvailable && event?.breaking),
      skipped,
      newerTag,
      newerMajorTag,
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
