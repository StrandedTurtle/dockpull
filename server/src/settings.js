/**
 * App settings: a small typed layer over the key/value `settings` table.
 *
 * Each setting declares a default and a coercion from the stored string. New
 * settings (e.g. the background scheduler / Discord webhook in a later phase)
 * just get added to SPEC. `getSettings()` always returns a fully-populated,
 * typed object (defaults merged over stored values); `updateSettings()` takes
 * a partial patch, validates known keys, and persists them.
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

const SPEC = {
  defaultFilter: {
    default: 'updates',
    fromStore: enumOf(['updates', 'all'], 'updates'),
    fromInput: enumOf(['updates', 'all'], undefined), // undefined -> rejected
  },
  autoCheckOnOpen: {
    default: true,
    fromStore: (v) => bool(v, true),
    fromInput: (v) => (typeof v === 'boolean' ? v : undefined),
  },
};

/**
 * @returns {{ defaultFilter: 'updates'|'all', autoCheckOnOpen: boolean }}
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
 * @returns {{ defaultFilter: string, autoCheckOnOpen: boolean }}
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
    db.setSetting(key, typeof coerced === 'boolean' ? (coerced ? '1' : '0') : coerced);
  }
  return getSettings();
}

export default { getSettings, updateSettings };
