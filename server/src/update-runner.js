/**
 * The work behind each queued job (see jobs.js): run an update / tag switch /
 * revert, record history (including the tail of the live log), remember or
 * consume the rollback point, and notify on failure.
 *
 * Opt-in auto-revert: when an update or tag switch succeeds at pulling and
 * recreating but the container then comes up unhealthy, and the container has
 * "revert automatically" enabled, the previous image is restored straight away
 * in the same job (its log continues in the same live stream).
 *
 * Each `execute*` returns `{ success, message }` and finishes the container's
 * live log session (sse.finish) with that final outcome.
 */

import { updateContainer, revertContainer, imageExists, restoreComposeEdit } from './docker.js';
import { normalizeRef } from './reconcile.js';
import * as sse from './sse.js';
import { getSettings } from './settings.js';
import { sendFailure } from './notify.js';
import * as db from './db.js';

const LOG_LINES_SAVED = 200;

/** Best-effort "update failed" notification. Never throws or delays the result. */
export function notifyFailure(failure) {
  let s;
  try {
    s = getSettings();
  } catch {
    return;
  }
  if (!s.discordEnabled || !s.discordWebhookUrl || !s.notifyOnFailure) return;
  sendFailure(s.notifyType, s.discordWebhookUrl, failure)
    .then((r) => {
      if (!r.ok) console.warn(`update-runner: failure notification returned ${r.status}`);
    })
    .catch((err) => console.warn(`update-runner: failure notification failed: ${err.message}`));
}

const logFor = (name) => (line, stream) => sse.pushLog(name, line, stream);

/**
 * Update (or tag switch, via `run`) one container and record the outcome.
 * Does NOT finish the live session — the caller may continue it (auto-revert).
 *
 * @returns {Promise<{ success: boolean, message: string, unhealthy: boolean }>}
 */
async function performUpdate(name, image, run) {
  const since = sse.logCount(name);
  try {
    const result = await run(name, logFor(name));
    const oldVersion = db.getImageVersion(result.oldDigest) ?? result.oldVersion ?? null;
    db.recordUpdate({
      container_name: name,
      image,
      old_digest: result.oldDigest,
      new_digest: result.newDigest,
      old_version: oldVersion,
      new_version: db.getImageVersion(result.newDigest),
      status: result.success ? 'success' : 'failure',
      message: result.message,
      log: sse.logTail(name, LOG_LINES_SAVED, since),
    });
    // On success, clear any pending update event for this image so the
    // dashboard indicator goes away (a registry index digest and a platform
    // RepoDigest may never compare equal, so don't rely on that alone).
    if (result.success && image) {
      try {
        db.resolveEventsForRef(normalizeRef(image));
      } catch {
        // non-fatal
      }
    }
    // Remember how to undo this update whenever the image actually changed —
    // even on a health-downgraded "failure", so a broken update can be
    // reverted. Compare local image IDs: the old digest may be unknown.
    if (result.oldImageId && result.newImageId && result.oldImageId !== result.newImageId) {
      db.setRollbackPoint({
        container_name: name,
        image_id: result.oldImageId,
        image_ref: image,
        old_digest: result.oldDigest,
        old_version: oldVersion,
        compose_edit: result.composeEdit ?? null,
      });
    }
    return { success: result.success, message: result.message, unhealthy: result.healthy === false };
  } catch (err) {
    db.recordUpdate({
      container_name: name,
      image,
      status: 'failure',
      message: err.message,
      log: sse.logTail(name, LOG_LINES_SAVED, since),
    });
    return { success: false, message: err.message, unhealthy: false };
  }
}

/**
 * Revert a container to its rollback point and record the outcome. Does NOT
 * finish the live session.
 *
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function performRevert(name, image, rollback) {
  const since = sse.logCount(name);
  try {
    if (!(await imageExists(rollback.image_id))) {
      db.deleteRollbackPoint(name);
      const message = 'The previous image no longer exists (it may have been pruned), so this update can no longer be reverted.';
      sse.pushLog(name, message, 'stderr');
      return { success: false, message };
    }
    // Undo a tag switch's compose-file edit too, so the file and the container agree.
    if (rollback.compose_edit) restoreComposeEdit(rollback.compose_edit, (l) => sse.pushLog(name, l, 'stdout'));
    const result = await revertContainer(name, rollback.image_id, logFor(name), {
      imageRef: image,
      digest: rollback.old_digest,
    });
    db.recordUpdate({
      container_name: name,
      image,
      old_digest: result.oldDigest,
      new_digest: result.newDigest,
      old_version: db.getImageVersion(result.oldDigest),
      new_version: rollback.old_version ?? null,
      status: result.success ? 'success' : 'failure',
      message: result.message,
      log: sse.logTail(name, LOG_LINES_SAVED, since),
    });
    // A rollback point is single-use; the update it undid is re-detected later.
    if (result.success) db.deleteRollbackPoint(name);
    return { success: result.success, message: result.message };
  } catch (err) {
    db.recordUpdate({
      container_name: name,
      image,
      status: 'failure',
      message: err.message,
      log: sse.logTail(name, LOG_LINES_SAVED, since),
    });
    return { success: false, message: err.message };
  }
}

/**
 * Job body for an update or tag switch (`run` defaults to a plain update).
 * Applies opt-in auto-revert on an unhealthy result.
 */
export async function executeUpdate(name, image, run = updateContainer) {
  let outcome = await performUpdate(name, image, run);
  if (!outcome.success && outcome.unhealthy && db.getAutoRevert(name)) {
    const rollback = db.getRollbackPoint(name);
    if (rollback) {
      sse.pushLog(name, '— Unhealthy after updating; reverting automatically (auto-revert is on). —', 'stdout');
      const reverted = await performRevert(name, rollback.image_ref ?? image, rollback);
      // "Image updated, but <reason>. The new version may be broken — …" ->
      // just the reason; the advice to revert no longer applies.
      const reason = /but (.+?)\. The new version/.exec(outcome.message)?.[1] || 'it came up unhealthy';
      const prev = rollback.old_version ? `version ${rollback.old_version}` : 'the previous image';
      outcome = reverted.success
        ? { success: false, message: `The update didn't work (${reason}), so it was automatically reverted to ${prev}.` }
        : {
            success: false,
            message: `The update didn't work (${reason}), and the automatic revert also failed: ${reverted.message}`,
          };
    }
  }
  sse.finish(name, outcome);
  if (!outcome.success) notifyFailure({ name, image, action: 'update', message: outcome.message });
  return outcome;
}

/** Job body for a revert. */
export async function executeRevert(name, image, rollback) {
  const outcome = await performRevert(name, image, rollback);
  sse.finish(name, outcome);
  if (!outcome.success) notifyFailure({ name, image, action: 'revert', message: outcome.message });
  return outcome;
}

export default { executeUpdate, executeRevert, notifyFailure };
