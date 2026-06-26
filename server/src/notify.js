/**
 * Discord webhook notifier. Formats a concise "updates available" message and
 * POSTs it to a Discord (or Discord-compatible) webhook URL.
 *
 * The payload builder is a pure function so it can be unit-tested without the
 * network; `sendDiscord` does the actual POST.
 */

const MAX_LISTED = 25; // keep the message from blowing past Discord's limits

/**
 * Build a Discord webhook JSON payload from a list of containers that have an
 * available update.
 *
 * @param {Array<{ name: string, image: string, currentVersion?: string|null }>} items
 * @returns {{ content: string }}
 */
export function buildDiscordPayload(items) {
  const n = items.length;
  const header = `🔔 **${n} container update${n === 1 ? '' : 's'} available**`;
  const lines = items.slice(0, MAX_LISTED).map((i) => {
    const ver = i.currentVersion ? ` (current: ${i.currentVersion})` : '';
    return `• **${i.name}** — \`${i.image}\`${ver}`;
  });
  if (n > MAX_LISTED) {
    lines.push(`…and ${n - MAX_LISTED} more.`);
  }
  return { content: [header, ...lines].join('\n') };
}

/**
 * POST a payload to a webhook URL. Returns `{ ok, status }`; never throws for
 * an HTTP error (only for a network failure / timeout, which the caller
 * handles). Discord returns 204 on success.
 *
 * @param {string} url
 * @param {object} payload
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, status: number }>}
 */
export async function postWebhook(url, payload, { timeoutMs = 10000 } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { ok: res.ok, status: res.status };
}

/**
 * Send an "updates available" notification for the given items.
 *
 * @param {string} url - Discord webhook URL.
 * @param {Array<object>} items
 * @returns {Promise<{ ok: boolean, status: number }>}
 */
export function sendDiscordUpdates(url, items) {
  return postWebhook(url, buildDiscordPayload(items));
}

/**
 * Send a one-off test message so the user can confirm their webhook works.
 *
 * @param {string} url
 * @returns {Promise<{ ok: boolean, status: number }>}
 */
export function sendDiscordTest(url) {
  return postWebhook(url, {
    content: '✅ DockPull test message — your Discord webhook is configured correctly.',
  });
}

export default { buildDiscordPayload, postWebhook, sendDiscordUpdates, sendDiscordTest };
