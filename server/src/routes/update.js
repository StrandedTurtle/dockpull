/**
 * Update routes. Every update, revert and tag switch is queued on the server
 * (jobs.js) and runs there regardless of whether any page stays open; clients
 * follow along via GET /api/jobs and the per-container live log stream
 * GET /api/update/:name/stream (which replays the whole log on reconnect).
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
import { docker, imageExists, trackedImageRef, switchContainerTag } from '../docker.js';
import { normalizeRef } from '../reconcile.js';
import * as sse from '../sse.js';
import * as jobs from '../jobs.js';
import { executeUpdate, executeRevert } from '../update-runner.js';
import { getSettings } from '../settings.js';
import { sendBatchSummary } from '../notify.js';
import * as db from '../db.js';
import { validateContainerNameParam, isValidContainerName } from '../security.js';

export const updateRouter = express.Router();

// Every :name route talks to Docker; reject anything that isn't a container name.
updateRouter.param('name', validateContainerNameParam);

// --- The queue → live clients and notifications -------------------------
// Any change in the queue nudges dashboards (and the header's progress
// indicator) to re-read GET /api/jobs; a finished job also changes containers.
jobs.onChange((job) => {
  sse.broadcastGlobal({ type: 'jobs-changed' });
  if (job?.status === 'done') sse.broadcastGlobal({ type: 'containers-changed' });
});

jobs.onBatchDone((summary) => {
  let s;
  try {
    s = getSettings();
  } catch {
    return;
  }
  if (summary.total < 2 || !s.discordEnabled || !s.discordWebhookUrl || !s.notifyBatchSummary) return;
  sendBatchSummary(s.notifyType, s.discordWebhookUrl, summary).catch((err) =>
    console.warn(`update.js: batch summary notification failed: ${err.message}`)
  );
});

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

/** Inspect a container for queueing; maps Docker errors to HTTP responses. */
async function inspectOr(res, name) {
  try {
    return await docker.getContainer(name).inspect();
  } catch (err) {
    if (err.statusCode === 404) res.status(404).json({ error: 'not_found' });
    else if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') res.status(503).json({ error: 'docker_unavailable' });
    else res.status(500).json({ error: 'internal_error', message: err.message });
    return null;
  }
}

/**
 * Queue an update for a container (shared by single updates and Update all).
 * Starts its live log session right away so a client can attach while it waits.
 */
function queueUpdate(name, inspectData, { batchId = null, run, kind = 'update', meta = {} } = {}) {
  const image = trackedImageRef(inspectData);
  const project = inspectData.Config?.Labels?.[COMPOSE_PROJECT_LABEL] || null;
  const job = jobs.enqueue({
    name,
    kind,
    project,
    batchId,
    meta,
    execute: () => executeUpdate(name, image, run),
  });
  sse.startSession(name);
  if (job.status === 'queued') {
    sse.pushLog(
      name,
      job.waitingOn === 'stack'
        ? `Queued — updates in stack "${project}" run one at a time…`
        : 'Queued — waiting for a free slot (up to 3 updates run at once)…',
      'stdout'
    );
  }
  return job;
}

function busy(res) {
  return res.status(409).json({ error: 'update_in_progress' });
}

updateRouter.post('/api/update/:name', async (req, res) => {
  const { name } = req.params;
  const inspectData = await inspectOr(res, name);
  if (!inspectData) return undefined;
  if (jobs.isBusy(name)) return busy(res);
  const job = queueUpdate(name, inspectData);
  return res.status(200).json({ streamId: name, job });
});

/**
 * "Update all": queue every named container in one batch, run entirely on the
 * server — closing the page or locking the phone no longer stops it.
 * Body: { names: string[] }. Containers that are busy or gone are reported in
 * `skipped`, never silently dropped.
 */
updateRouter.post('/api/update-all', async (req, res) => {
  const names = Array.isArray(req.body?.names) ? [...new Set(req.body.names)] : null;
  if (!names || names.length === 0 || names.length > 500 || !names.every(isValidContainerName)) {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  const batchId = jobs.startBatch();
  const queued = [];
  const skipped = [];
  for (const name of names) {
    if (jobs.isBusy(name)) {
      skipped.push({ name, reason: 'already updating' });
      continue;
    }
    let inspectData;
    try {
      inspectData = await docker.getContainer(name).inspect();
    } catch (err) {
      skipped.push({ name, reason: err.statusCode === 404 ? 'not found' : 'docker unavailable' });
      continue;
    }
    queueUpdate(name, inspectData, { batchId });
    queued.push(name);
  }
  jobs.sealBatch(batchId);
  return res.status(200).json({ batchId, queued, skipped });
});

/** What's queued/running now (and what finished recently), for any client. */
updateRouter.get('/api/jobs', (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.status(200).json(jobs.snapshot());
});

/** Per-container "revert automatically if the update comes up unhealthy". */
updateRouter.put('/api/containers/:name/auto-revert', (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'invalid_payload' });
  db.setAutoRevert(req.params.name, enabled);
  sse.broadcastGlobal({ type: 'containers-changed' });
  return res.status(200).json({ ok: true, enabled });
});

updateRouter.post('/api/update/:name/revert', async (req, res) => {
  const { name } = req.params;

  const rollback = db.getRollbackPoint(name);
  if (!rollback) {
    return res.status(404).json({ error: 'no_rollback' });
  }
  const inspectData = await inspectOr(res, name);
  if (!inspectData) return undefined;
  if (jobs.isBusy(name)) return busy(res);

  // The saved image can disappear (pruned, or removed by hand). Check before
  // queueing, and forget the dead rollback point.
  try {
    if (!(await imageExists(rollback.image_id))) {
      db.deleteRollbackPoint(name);
      sse.broadcastGlobal({ type: 'containers-changed' });
      return res.status(410).json({
        error: 'rollback_image_gone',
        message: 'The previous image no longer exists (it may have been pruned), so this update can no longer be reverted.',
      });
    }
  } catch {
    return res.status(503).json({ error: 'docker_unavailable' });
  }

  const image = rollback.image_ref ?? trackedImageRef(inspectData);
  const project = inspectData.Config?.Labels?.[COMPOSE_PROJECT_LABEL] || null;
  const job = jobs.enqueue({
    name,
    kind: 'revert',
    project,
    execute: () => executeRevert(name, image, rollback),
  });
  sse.startSession(name);
  return res.status(200).json({ streamId: name, job });
});

// Docker tag grammar: [A-Za-z0-9_][A-Za-z0-9_.-]{0,127}
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/**
 * Move a container to a newer version tag the last check found (see
 * tag_updates). Only tags DockPull itself offered are accepted.
 */
updateRouter.post('/api/update/:name/switch-tag', async (req, res) => {
  const { name } = req.params;
  const tag = req.body?.tag;
  if (typeof tag !== 'string' || !TAG_RE.test(tag)) {
    return res.status(400).json({ error: 'invalid_tag' });
  }

  const inspectData = await inspectOr(res, name);
  if (!inspectData) return undefined;
  const image = trackedImageRef(inspectData);
  let ref;
  try {
    ref = normalizeRef(image);
  } catch {
    return res.status(400).json({ error: 'invalid_image' });
  }
  const offered = db.getTagUpdate(ref);
  if (!offered || (offered.same_major !== tag && offered.next_major !== tag)) {
    return res.status(409).json({
      error: 'tag_not_offered',
      message: `${tag} isn't a newer version DockPull found for this image. Run a check first.`,
    });
  }

  if (jobs.isBusy(name)) return busy(res);
  // The tag_updates row belongs to the OLD tag and may still apply to other
  // containers running it, so it's left alone; the switched container now has
  // a new ref, whose newer tags the next check works out.
  const job = queueUpdate(name, inspectData, {
    kind: 'switch',
    meta: { tag },
    run: (n, onLine) => switchContainerTag(n, tag, onLine),
  });
  return res.status(200).json({ streamId: name, job });
});

updateRouter.get('/api/update/:name/stream', (req, res) => {
  sse.subscribe(req.params.name, res, req);
});

export default updateRouter;
