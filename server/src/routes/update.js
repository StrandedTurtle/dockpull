/**
 * Update routes: POST /api/update/:name, GET /api/update/:name/stream.
 *
 * Auth: protected by the session-cookie middleware mounted ahead of this
 * router in index.js (see API_CONTRACT.md). This router adds no auth
 * itself.
 *
 * NOTE: the actual pull + recreate work happens in docker.js's
 * `updateContainer`, which shells out to the `docker` CLI / talks to the
 * daemon over `DOCKER_SOCKET`. There is no Docker daemon available in this
 * build/test environment, so the success path of POST /api/update/:name
 * (and the resulting SSE log/result events) can only be exercised on a
 * real host — see the work package report.
 */

import express from 'express';
import { docker, updateContainer, revertContainer } from '../docker.js';
import { normalizeRef } from '../reconcile.js';
import * as sse from '../sse.js';
import * as db from '../db.js';

export const updateRouter = express.Router();

/**
 * Runs the update + records history + finishes the SSE session, detached
 * from the request lifecycle (the POST handler responds before this
 * settles). Errors here must never escape as an unhandled rejection.
 *
 * @param {string} name
 * @param {string|null} image - configured image ref, for the history row.
 */
async function runUpdate(name, image) {
  try {
    const result = await updateContainer(name, (line, stream) => sse.pushLog(name, line, stream));
    db.recordUpdate({
      container_name: name,
      image,
      old_digest: result.oldDigest,
      new_digest: result.newDigest,
      status: result.success ? 'success' : 'failure',
      message: result.message,
    });
    // On success, clear any pending update event for this image so the
    // dashboard indicator goes away — we just pulled the latest. Relying on
    // the digest-equality check in /api/containers alone is not enough:
    // A registry can report a manifest-list (multi-arch) digest while the
    // container's RepoDigest is platform-specific, so they'd never match and
    // the badge would stick forever.
    if (result.success && image) {
      try {
        db.resolveEventsForRef(normalizeRef(image));
      } catch {
        // normalizeRef shouldn't throw for a real image ref; non-fatal.
      }
    }
    // Remember how to undo this update (the previous local image) whenever the
    // image actually changed — even on a health-downgraded "failure", so the
    // user can revert a broken update.
    if (result.oldImageId && result.newDigest && result.oldDigest && result.newDigest !== result.oldDigest) {
      db.setRollbackPoint({
        container_name: name,
        image_id: result.oldImageId,
        image_ref: image,
        old_digest: result.oldDigest,
        old_version: db.getImageVersion(result.oldDigest),
      });
    }
    sse.finish(name, { success: result.success, message: result.message });
  } catch (err) {
    db.recordUpdate({
      container_name: name,
      image,
      old_digest: null,
      new_digest: null,
      status: 'failure',
      message: err.message,
    });
    sse.finish(name, { success: false, message: err.message });
  } finally {
    // Let other connected dashboards refresh their list/badges.
    sse.broadcastGlobal({ type: 'containers-changed' });
  }
}

updateRouter.post('/api/update/:name', async (req, res) => {
  const { name } = req.params;

  let inspectData;
  try {
    inspectData = await docker.getContainer(name).inspect();
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'docker_unavailable' });
    }
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }

  if (sse.isActive(name)) {
    return res.status(409).json({ error: 'update_in_progress' });
  }

  sse.startSession(name);

  const image = inspectData.Config?.Image ?? null;
  // Fire-and-forget: don't await, so the POST returns promptly. runUpdate
  // catches its own errors, so this can never reject/crash the process.
  void runUpdate(name, image);

  return res.status(200).json({ streamId: name });
});

/**
 * Detached revert: recreate the container from its remembered previous image,
 * record history, and finish the SSE session. Mirrors runUpdate.
 */
async function runRevert(name, image, imageId) {
  try {
    const result = await revertContainer(name, imageId, (line, stream) => sse.pushLog(name, line, stream));
    db.recordUpdate({
      container_name: name,
      image,
      old_digest: result.oldDigest,
      new_digest: result.newDigest,
      status: result.success ? 'success' : 'failure',
      message: result.message,
    });
    // Consume the rollback point on a successful revert (can't revert twice to
    // the same image). The update it reverted away from will simply be
    // re-detected as available on the next check.
    if (result.success) db.deleteRollbackPoint(name);
    sse.finish(name, { success: result.success, message: result.message });
  } catch (err) {
    db.recordUpdate({
      container_name: name,
      image,
      old_digest: null,
      new_digest: null,
      status: 'failure',
      message: err.message,
    });
    sse.finish(name, { success: false, message: err.message });
  } finally {
    sse.broadcastGlobal({ type: 'containers-changed' });
  }
}

updateRouter.post('/api/update/:name/revert', async (req, res) => {
  const { name } = req.params;

  const rollback = db.getRollbackPoint(name);
  if (!rollback) {
    return res.status(404).json({ error: 'no_rollback' });
  }

  let inspectData;
  try {
    inspectData = await docker.getContainer(name).inspect();
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: 'not_found' });
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'docker_unavailable' });
    }
    return res.status(500).json({ error: 'internal_error' });
  }

  if (sse.isActive(name)) {
    return res.status(409).json({ error: 'update_in_progress' });
  }

  sse.startSession(name);
  const image = inspectData.Config?.Image ?? rollback.image_ref ?? null;
  void runRevert(name, image, rollback.image_id);

  return res.status(200).json({ streamId: name });
});

updateRouter.get('/api/update/:name/stream', (req, res) => {
  sse.subscribe(req.params.name, res, req);
});

export default updateRouter;
