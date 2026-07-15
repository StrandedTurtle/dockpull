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
import { listContainers, listDanglingImages } from './docker.js';
import { buildContainerItems } from './containers-service.js';
import { normalizeRef } from './reconcile.js';
import { sendUpdates } from './notify.js';
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
 * Decide what a notification run should announce. The message lists every
 * container that currently has an unapplied, unpinned update -- not just the
 * ones that haven't been announced yet -- so each message is a complete,
 * actionable summary of everything pending (a still-unapplied update must
 * never silently drop out of later messages just because it was mentioned
 * once before). We only actually send when at least one of those is new
 * since the last notification, so a fully-stale pending list doesn't get
 * re-pinged on every run.
 *
 * @param {Array<{updateAvailable: boolean, pinned: boolean, image: string}>} items
 * @param {Set<string>} unnotifiedRefs - normalized refs not yet announced.
 * @param {(image: string) => string} normalizeRefFn
 * @returns {{ toNotify: object[], hasNew: boolean }}
 */
export function selectNotifyTargets(items, unnotifiedRefs, normalizeRefFn) {
  const toNotify = items.filter((i) => i.updateAvailable && !i.pinned);
  const hasNew = toNotify.some((i) => {
    try {
      return unnotifiedRefs.has(normalizeRefFn(i.image));
    } catch {
      return false;
    }
  });
  return { toNotify, hasNew };
}

/**
 * Run a check, then notify Discord about updates not yet announced. Resilient:
 * any failure (no Docker daemon, registry error, webhook down) is logged, not
 * thrown — the scheduler keeps running.
 */
export async function runScheduledCheck() {
  await runCheck();

  // Best-effort: note whether there's anything to prune, so the client can
  // show a badge without hitting the Docker API on every page load. Never
  // let this block the update-check/notify flow below it.
  try {
    const dangling = await listDanglingImages();
    db.setMeta('danglingImages', {
      count: dangling.count,
      totalSize: dangling.totalSize,
      checkedAt: Date.now(),
    });
  } catch (err) {
    console.warn(`scheduler: dangling-image check failed: ${err.message}`);
  }

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

  const { toNotify, hasNew } = selectNotifyTargets(items, unnotified, normalizeRef);
  if (toNotify.length === 0 || !hasNew) return;

  const result = await sendUpdates(settings.notifyType, settings.discordWebhookUrl, toNotify);
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

export default { start, stop, reschedule, runScheduledCheck, msUntilNext, selectNotifyTargets };
