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

function bool(v, fallback) {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  return v === '1' || v === 'true';
}

function enumOf(allowed, fallback) {
  return (v) => (allowed.includes(v) ? v : fallback);
}

function intInOrUndef(min, max) {
  return (v) => {
    const n = typeof v === 'number' ? v : parseInt(v, 10);
    if (!Number.isFinite(n) || n < min || n > max) return undefined;
    return Math.trunc(n);
  };
}

function urlOrUndef(v) {
  if (v === '') return '';
  if (typeof v === 'string' && /^https?:\/\//i.test(v.trim())) return v.trim();
  return undefined;
}

// --- env-seeded defaults ---
const ENV_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';
const ENV_INTERVAL = intInOrUndef(1, 168)(process.env.CHECK_INTERVAL_HOURS) ?? 6;
const ENV_BG_ENABLED = bool(process.env.BACKGROUND_CHECK_ENABLED, true);

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
  backgroundCheckIntervalHours: {
    default: ENV_INTERVAL,
    fromStore: (v) => intInOrUndef(1, 168)(v) ?? ENV_INTERVAL,
    fromInput: intInOrUndef(1, 168),
  },
  discordEnabled: {
    default: ENV_WEBHOOK !== '',
    fromStore: (v) => bool(v, ENV_WEBHOOK !== ''),
    fromInput: (v) => (typeof v === 'boolean' ? v : undefined),
  },
  discordWebhookUrl: {
    default: ENV_WEBHOOK,
    fromStore: (v) => (typeof v === 'string' ? v : ENV_WEBHOOK),
    fromInput: urlOrUndef,
  },
};

/**
 * @returns {{
 *   defaultFilter: 'updates'|'all',
 *   autoCheckOnOpen: boolean,
 *   backgroundCheckEnabled: boolean,
 *   backgroundCheckIntervalHours: number,
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
