/**
 * App settings: a small typed layer over the key/value `settings` table.
 *
 * Each setting declares a default and coercions from the stored string and
 * from a client-supplied input. `getSettings()` always returns a fully
 * populated, typed object (defaults merged over stored values);
 * `updateSettings()` takes a partial patch, validates known keys, and persists
 * them. Defaults can be seeded from env vars so ops can configure via the
 * environment, with the Settings UI overriding at runtime.
 */

import * as db from './db.js';
import { isValidNotifyUrl } from './urlguard.js';
import { NOTIFY_TYPES } from './notify.js';

function bool(v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  return v === '1' || v === 'true';
}

function enumOf(allowed, fallback) {
  return (v) => (allowed.includes(v) ? v : fallback);
}

function isValidTime(v) {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim());
}

function timeOrUndef(v) {
  return isValidTime(v) ? v.trim() : undefined;
}

// Accept an empty string (clears the target) or a valid http(s) URL. Internal/
// LAN hosts are allowed on purpose — a self-hosted ntfy/Gotify is a normal
// target and this field is admin-only.
function urlOrUndef(v) {
  if (v === '') return '';
  if (typeof v === 'string' && isValidNotifyUrl(v)) return v.trim();
  return undefined;
}

// --- env-seeded defaults ---
const ENV_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const ENV_TIME = isValidTime(process.env.SCHEDULED_CHECK_TIME)
  ? process.env.SCHEDULED_CHECK_TIME.trim()
  : '09:00';
const ENV_BG_ENABLED = bool(process.env.BACKGROUND_CHECK_ENABLED, true);
const ENV_NOTIFY_TYPE = NOTIFY_TYPES.includes(process.env.NOTIFY_TYPE)
  ? process.env.NOTIFY_TYPE
  : 'discord';

const SPEC = {
  defaultFilter: {
    default: 'updates',
    fromStore: enumOf(['updates', 'all'], 'updates'),
    fromInput: enumOf(['updates', 'all'], undefined),
  },
  autoCheckOnOpen: {
    default: true,
    fromStore: (v) => bool(v, true),
    fromInput: (v) => (typeof v === 'boolean' ? v : undefined),
  },
  backgroundCheckEnabled: {
    default: ENV_BG_ENABLED,
    fromStore: (v) => bool(v, ENV_BG_ENABLED),
    fromInput: (v) => (typeof v === 'boolean' ? v : undefined),
  },
  // Daily local time (HH:MM, 24h) for the scheduled scan.
  scheduledCheckTime: {
    default: ENV_TIME,
    fromStore: (v) => (isValidTime(v) ? v.trim() : ENV_TIME),
    fromInput: timeOrUndef,
  },
  // Master "send notifications" toggle (kept this key for back-compat).
  discordEnabled: {
    default: ENV_WEBHOOK !== '',
    fromStore: (v) => bool(v, ENV_WEBHOOK !== ''),
    fromInput: (v) => (typeof v === 'boolean' ? v : undefined),
  },
  // Notification target URL (used for whichever notifyType is selected; key
  // kept as discordWebhookUrl for back-compat with stored settings).
  discordWebhookUrl: {
    default: ENV_WEBHOOK,
    fromStore: (v) => (typeof v === 'string' ? v : ENV_WEBHOOK),
    fromInput: urlOrUndef,
  },
  notifyType: {
    default: ENV_NOTIFY_TYPE,
    fromStore: enumOf(NOTIFY_TYPES, ENV_NOTIFY_TYPE),
    fromInput: enumOf(NOTIFY_TYPES, undefined),
  },
};

/**
 * @returns {{
 *   defaultFilter: 'updates'|'all',
 *   autoCheckOnOpen: boolean,
 *   backgroundCheckEnabled: boolean,
 *   scheduledCheckTime: string,
 *   discordEnabled: boolean,
 *   discordWebhookUrl: string,
 * }}
 */
export function getSettings() {
  const stored = db.getAllSettings();
  const out = {};
  for (const [key, spec] of Object.entries(SPEC)) {
    out[key] = key in stored ? spec.fromStore(stored[key]) : spec.default;
  }
  return out;
}

/**
 * Validate + persist a partial patch. Unknown keys are ignored; invalid values
 * for known keys are rejected (the whole call fails so the client gets clear
 * feedback). Returns the full, updated settings object.
 *
 * @param {Record<string, unknown>} patch
 * @returns {object} the full, updated settings
 * @throws {Error} with `.code = 'invalid_value'` on a bad known value.
 */
export function updateSettings(patch) {
  if (!patch || typeof patch !== 'object') {
    const err = new Error('settings patch must be an object');
    err.code = 'invalid_value';
    throw err;
  }
  for (const [key, raw] of Object.entries(patch)) {
    const spec = SPEC[key];
    if (!spec) continue; // ignore unknown keys
    const coerced = spec.fromInput(raw);
    if (coerced === undefined) {
      const err = new Error(`invalid value for setting "${key}"`);
      err.code = 'invalid_value';
      throw err;
    }
    db.setSetting(key, typeof coerced === 'boolean' ? (coerced ? '1' : '0') : String(coerced));
  }
  return getSettings();
}

export default { getSettings, updateSettings };
