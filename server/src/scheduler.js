/**
 * Background update checker. Periodically runs the same registry check the
 * "Check for updates" button triggers, then (if a Discord webhook is
 * configured) notifies about any newly-found updates — deduped so each update
 * is announced once.
 *
 * Interval/enable are driven by settings; call `reschedule()` after settings
 * change so the timer picks up the new values. A plain setInterval is enough —
 * no cron dependency.
 */

import { getSettings } from './settings.js';
import { runCheck } from './checker.js';
import { listContainers } from './docker.js';
import { buildContainerItems } from './containers-service.js';
import { normalizeRef } from './reconcile.js';
import { sendDiscordUpdates } from './notify.js';
import * as db from './db.js';

let timer = null;
let running = false;

/**
 * Run a check, then notify Discord about updates not yet announced. Resilient:
 * any failure (no Docker daemon, registry error, webhook down) is logged, not
 * thrown — the scheduler keeps ticking.
 */
export async function runScheduledCheck() {
  await runCheck();

  const settings = getSettings();
  if (!settings.discordEnabled || !settings.discordWebhookUrl) {
    return; // checks still keep the dashboard fresh; just no notification
  }

  const unnotified = new Set(db.getUnnotifiedRefs());
  if (unnotified.size === 0) return;

  const containers = await listContainers();
  const { items } = buildContainerItems({
    containers,
    lookupEvent: db.latestUnresolvedEventForRef,
    isPinned: (ref) => db.isPinned(ref),
  });

  const toNotify = items.filter((i) => {
    if (!i.updateAvailable || i.pinned) return false;
    try {
      return unnotified.has(normalizeRef(i.image));
    } catch {
      return false;
    }
  });
  if (toNotify.length === 0) return;

  const result = await sendDiscordUpdates(settings.discordWebhookUrl, toNotify);
  if (result.ok) {
    db.markRefsNotified(toNotify.map((i) => normalizeRef(i.image)));
  } else {
    console.warn(`scheduler: Discord webhook returned ${result.status}; will retry next run`);
  }
}

async function tick() {
  if (running) return; // never overlap runs
  running = true;
  try {
    await runScheduledCheck();
  } catch (err) {
    console.warn(`scheduler: scheduled check failed: ${err.message}`);
  } finally {
    running = false;
  }
}

/**
 * (Re)arm the interval from current settings. Clears any existing timer first.
 * No-op timer when background checks are disabled.
 */
export function reschedule() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const s = getSettings();
  if (!s.backgroundCheckEnabled) return;
  const hours = Math.min(Math.max(s.backgroundCheckIntervalHours || 6, 1), 168);
  timer = setInterval(tick, hours * 3600 * 1000);
  // setInterval keeps the event loop alive; that's fine for a long-running
  // server, and graceful shutdown clears it.
}

export function start() {
  reschedule();
}

export function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export default { start, stop, reschedule, runScheduledCheck };
