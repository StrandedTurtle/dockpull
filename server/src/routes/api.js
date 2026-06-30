/**
 * Reconciliation + history + pin routes: GET /api/containers, GET
 * /api/history(/:name), GET /api/pinned, POST /api/pin, DELETE /api/pin/:ref.
 *
 * Auth: per API_CONTRACT.md these are all protected by the session cookie
 * — WP3 will insert that auth middleware ahead of this router (see the
 * mounting comment in index.js). This router itself adds no auth.
 */

import express from 'express';
import { listContainers, getContainerImageMeta } from '../docker.js';
import { buildContainerItems } from '../containers-service.js';
import { normalizeRef } from '../reconcile.js';
import { runCheck } from '../checker.js';
import { subscribeGlobal, broadcastGlobal } from '../sse.js';
import { getSettings, updateSettings } from '../settings.js';
import scheduler from '../scheduler.js';
import { sendDiscordTest } from '../notify.js';
import { getChangelog } from '../changelog.js';
import { isSafeWebhookUrl } from '../urlguard.js';
import * as db from '../db.js';

export const apiRouter = express.Router();

/**
 * Coerces a query param to a non-negative integer, falling back to
 * `fallback` if it's missing, not a number, or negative.
 *
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
function toSafeInt(raw, fallback, max = Infinity) {
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

apiRouter.get('/api/containers', async (req, res) => {
  let containers;
  try {
    containers = await listContainers();
  } catch (err) {
    console.error(`api.js: GET /api/containers failed to list containers: ${err.message}`);
    return res.status(503).json({ error: 'docker_unavailable' });
  }

  const { items, refsToResolve } = buildContainerItems({
    containers,
    lookupEvent: db.latestUnresolvedEventForRef,
    isPinned: (ref) => db.isPinned(ref),
  });

  for (const ref of refsToResolve) {
    db.resolveEventsForRef(ref);
  }

  return res.status(200).json(items);
});

// Actively check registries for newer digests.
apiRouter.post('/api/check', async (req, res) => {
  let result;
  try {
    result = await runCheck();
  } catch (err) {
    console.error(`api.js: POST /api/check failed: ${err.message}`);
    return res.status(503).json({ error: 'docker_unavailable' });
  }
  broadcastGlobal({ type: 'containers-changed' });
  return res.status(200).json(result);
});

// Global SSE channel: emits {"type":"containers-changed"} when server state
// changes (a manual/scheduled check or a finished update) so dashboards can
// refresh without a manual reload.
apiRouter.get('/api/events', (req, res) => {
  subscribeGlobal(res, req);
});

apiRouter.get('/api/history', (req, res) => {
  const limit = toSafeInt(req.query.limit, 50, 500);
  const offset = toSafeInt(req.query.offset, 0);
  const rows = db.getHistory({ containerName: req.query.container, limit, offset });
  return res.status(200).json(rows);
});

apiRouter.get('/api/history/:name', (req, res) => {
  const limit = toSafeInt(req.query.limit, 50, 500);
  const offset = toSafeInt(req.query.offset, 0);
  const rows = db.getHistory({ containerName: req.params.name, limit, offset });
  return res.status(200).json(rows);
});

// Wipe all update history (behind requireAuth, like the rest of /api/*).
apiRouter.delete('/api/history', (req, res) => {
  db.clearHistory();
  return res.status(200).json({ ok: true });
});

apiRouter.get('/api/pinned', (req, res) => {
  return res.status(200).json(db.getPinned());
});

apiRouter.post('/api/pin', (req, res) => {
  const ref = req.body?.ref;
  if (typeof ref !== 'string' || ref.trim() === '') {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  let normalized;
  try {
    normalized = normalizeRef(ref);
  } catch {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  db.pin(normalized);
  broadcastGlobal({ type: 'containers-changed' });
  return res.status(200).json({ ok: true });
});

apiRouter.delete('/api/pin/:ref', (req, res) => {
  let normalized;
  try {
    normalized = normalizeRef(decodeURIComponent(req.params.ref));
  } catch {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  db.unpin(normalized);
  broadcastGlobal({ type: 'containers-changed' });
  return res.status(200).json({ ok: true });
});

// --- Settings ---

apiRouter.get('/api/settings', (req, res) => {
  return res.status(200).json(getSettings());
});

apiRouter.put('/api/settings', (req, res) => {
  try {
    const updated = updateSettings(req.body || {});
    scheduler.reschedule();
    return res.status(200).json(updated);
  } catch (err) {
    if (err.code === 'invalid_value') {
      return res.status(400).json({ error: 'invalid_value', message: err.message });
    }
    throw err;
  }
});

// Send a test Discord message to the configured (or supplied) webhook URL.
apiRouter.post('/api/notify/test', async (req, res) => {
  const url =
    (typeof req.body?.url === 'string' && req.body.url.trim()) || getSettings().discordWebhookUrl;
  if (!url) {
    return res.status(400).json({ error: 'no_webhook', message: 'No Discord webhook URL configured.' });
  }
  // SSRF guard: only allow an https webhook to a public host (also enforced at
  // send time, but reject early with a clear message here).
  if (!isSafeWebhookUrl(url)) {
    return res
      .status(400)
      .json({ error: 'invalid_webhook', message: 'Webhook must be an https URL to a public host.' });
  }
  try {
    const result = await sendDiscordTest(url);
    if (result.ok) return res.status(200).json({ ok: true });
    return res.status(502).json({ error: 'webhook_failed', status: result.status });
  } catch (err) {
    console.error(`api.js: POST /api/notify/test failed: ${err.message}`);
    if (err.code === 'unsafe_url') {
      return res
        .status(400)
        .json({ error: 'invalid_webhook', message: 'Webhook must be an https URL to a public host.' });
    }
    return res.status(502).json({ error: 'webhook_failed' });
  }
});

// Best-effort changelog for a container's image (GitHub releases newer than
// the running version, or a link-out). Cached briefly per image+version.
const changelogCache = new Map(); // key -> { at, data }
const CHANGELOG_TTL_MS = 10 * 60 * 1000;

apiRouter.get('/api/changelog/:name', async (req, res) => {
  let meta;
  try {
    meta = await getContainerImageMeta(req.params.name);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: 'not_found' });
    console.error(`api.js: GET /api/changelog/${req.params.name} inspect failed: ${err.message}`);
    return res.status(503).json({ error: 'docker_unavailable' });
  }
  if (!meta.image) return res.status(404).json({ error: 'not_found' });

  const key = `${meta.image}|${meta.currentVersion || ''}`;
  const cached = changelogCache.get(key);
  if (cached && Date.now() - cached.at < CHANGELOG_TTL_MS) {
    return res.status(200).json(cached.data);
  }
  try {
    const data = await getChangelog(meta);
    changelogCache.set(key, { at: Date.now(), data });
    return res.status(200).json(data);
  } catch (err) {
    console.error(`api.js: GET /api/changelog/${req.params.name} failed: ${err.message}`);
    return res.status(502).json({ error: 'changelog_failed' });
  }
});

export default apiRouter;
