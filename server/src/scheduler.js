/**
 * Background update checker. Runs the same registry check the "Check for
 * updates" button triggers once a day at a configured local time, then (if a
 * Discord webhook is configured) notifies about any newly-found updates —
 * deduped so each update is announced once. This mirrors a daily cron ping:
 * set it to e.g. 09:00 to get a morning "go update" message.
 *
 * Time/enable are driven by settings; call `reschedule()` after settings change
 * so the next firing picks up the new values.
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
 * Milliseconds until the next occurrence of a daily HH:MM (server local time).
 * @param {string} timeStr
 * @returns {number}
 */
export function msUntilNext(timeStr, now = new Date()) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((timeStr || '').trim());
  const hh = m ? Number(m[1]) : 9;
  const mm = m ? Number(m[2]) : 0;
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Run a check, then notify Discord about updates not yet announced. Resilient:
 * any failure (no Docker daemon, registry error, webhook down) is logged, not
 * thrown — the scheduler keeps running.
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

async function fire() {
  await tick();
  reschedule(); // arm for the next day
}

/**
 * (Re)arm the daily timer from current settings. Clears any existing timer
 * first; no-op when background checks are disabled.
 */
export function reschedule() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const s = getSettings();
  if (!s.backgroundCheckEnabled) return;
  timer = setTimeout(fire, msUntilNext(s.scheduledCheckTime));
}

export function start() {
  reschedule();
}

export function stop() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export default { start, stop, reschedule, runScheduledCheck, msUntilNext };
