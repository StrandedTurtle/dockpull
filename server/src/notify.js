/**
 * Update notifications. Builds an "updates available" message and delivers it
 * to the configured target. Supports several homelab-friendly targets:
 *
 *  - `discord` — Discord (or compatible) webhook: JSON `{ content }`.
 *  - `ntfy`    — ntfy topic URL: plain-text body + `Title`/`Tags` headers.
 *  - `gotify`  — Gotify `/message?token=...` URL: JSON `{ title, message }`.
 *  - `webhook` — generic JSON `{ title, message, count, containers[] }`.
 *
 * Payload builders are pure (unit-tested); the `send*` functions do the POST.
 */

import { isValidNotifyUrl } from './urlguard.js';

const MAX_LISTED = 25; // keep messages from blowing past provider limits

export const NOTIFY_TYPES = ['discord', 'ntfy', 'gotify', 'webhook'];

// "(1.2.3 → 1.2.4)", "(current: 1.2.3)", or "" — whatever versions we know.
function versionSuffix(i) {
  const cur = i.currentVersion || null;
  const avail = i.availableVersion || null;
  if (cur && avail && cur !== avail) return ` (${cur} → ${avail})`;
  if (cur && avail) return ` (${cur}, rebuilt)`;
  if (avail) return ` (→ ${avail})`;
  if (cur) return ` (current: ${cur})`;
  return '';
}

function summaryLines(items) {
  return items.slice(0, MAX_LISTED).map((i) => {
    const warn = i.breakingRisk ? '⚠️ ' : '';
    return `• ${warn}${i.name} — ${i.image}${versionSuffix(i)}`;
  });
}

function moreLine(items) {
  return items.length > MAX_LISTED ? [`…and ${items.length - MAX_LISTED} more.`] : [];
}

function title(items) {
  const n = items.length;
  return `${n} container update${n === 1 ? '' : 's'} available`;
}

/**
 * Build a Discord webhook JSON payload.
 * @param {Array<{ name: string, image: string, currentVersion?: string|null }>} items
 * @returns {{ content: string }}
 */
export function buildDiscordPayload(items) {
  const header = `🔔 **${title(items)}**`;
  const lines = items.slice(0, MAX_LISTED).map((i) => {
    const warn = i.breakingRisk ? '⚠️ ' : '';
    return `• ${warn}**${i.name}** — \`${i.image}\`${versionSuffix(i)}`;
  });
  return { content: [header, ...lines, ...moreLine(items)].join('\n') };
}

/** ntfy: plain-text body + headers. */
export function buildNtfyMessage(items) {
  return {
    title: `🔔 ${title(items)}`,
    body: [...summaryLines(items), ...moreLine(items)].join('\n'),
    tags: 'package',
  };
}

/** Gotify message JSON. */
export function buildGotifyPayload(items) {
  return {
    title: title(items),
    message: [...summaryLines(items), ...moreLine(items)].join('\n'),
    priority: 5,
  };
}

/** Generic webhook JSON. */
export function buildWebhookPayload(items) {
  return {
    title: title(items),
    message: [...summaryLines(items), ...moreLine(items)].join('\n'),
    count: items.length,
    containers: items.slice(0, MAX_LISTED).map((i) => ({
      name: i.name,
      image: i.image,
      currentVersion: i.currentVersion ?? null,
      availableVersion: i.availableVersion ?? null,
    })),
  };
}

function assertValidUrl(url) {
  if (!isValidNotifyUrl(url)) {
    const err = new Error('notification URL is not a valid http(s) URL');
    err.code = 'invalid_url';
    throw err;
  }
}

async function postJson(url, payload, { timeoutMs = 10000 } = {}) {
  assertValidUrl(url);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { ok: res.ok, status: res.status };
}

/**
 * ntfy target URL carrying the title/tags as query parameters. ntfy accepts
 * them either as headers or as `?title=&tags=`; headers can't be used here
 * because fetch only allows Latin-1 header values and our titles contain
 * emoji (a `Title: 🔔 …` header throws before the request is even sent).
 * Query params are percent-encoded UTF-8, so they're always safe.
 */
export function buildNtfyUrl(url, { title: t, tags } = {}) {
  const u = new URL(url.trim());
  if (t) u.searchParams.set('title', t);
  if (tags) u.searchParams.set('tags', tags);
  return u.toString();
}

async function postNtfy(url, message, { timeoutMs = 10000 } = {}) {
  assertValidUrl(url);
  const res = await fetch(buildNtfyUrl(url, message), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: message.body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { ok: res.ok, status: res.status };
}

/**
 * Send an "updates available" notification to the configured target.
 * @returns {Promise<{ ok: boolean, status: number }>}
 */
export function sendUpdates(type, url, items, opts) {
  switch (type) {
    case 'ntfy':
      return postNtfy(url, buildNtfyMessage(items), opts);
    case 'gotify':
      return postJson(url, buildGotifyPayload(items), opts);
    case 'webhook':
      return postJson(url, buildWebhookPayload(items), opts);
    case 'discord':
    default:
      return postJson(url, buildDiscordPayload(items), opts);
  }
}

/** Send a one-off test message so the user can confirm their target works. */
export function sendTest(type, url, opts) {
  const text = '✅ DockPull test — your notifications are configured correctly.';
  switch (type) {
    case 'ntfy':
      // Same emoji-bearing title style as real notifications, so a passing
      // test really proves real notifications will get through.
      return postNtfy(url, { title: '✅ DockPull test', tags: 'white_check_mark', body: text }, opts);
    case 'gotify':
      return postJson(url, { title: 'DockPull test', message: text, priority: 5 }, opts);
    case 'webhook':
      return postJson(url, { title: 'DockPull test', message: text, count: 0, containers: [] }, opts);
    case 'discord':
    default:
      return postJson(url, { content: text }, opts);
  }
}

export default {
  NOTIFY_TYPES,
  buildDiscordPayload,
  buildNtfyMessage,
  buildNtfyUrl,
  buildGotifyPayload,
  buildWebhookPayload,
  sendUpdates,
  sendTest,
};
