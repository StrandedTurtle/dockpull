/**
 * Settings backup / restore, for moving DockPull to a new host or recovering
 * a lost data volume. The backup is plain JSON: settings, pinned images, and
 * update history. Short-lived state (pending updates, skips, revert points)
 * is left out — it's rebuilt by the next check or meaningless on another host.
 *
 * Restore validates everything through the same paths as normal API writes
 * (updateSettings, normalizeRef) and is safe to run twice: history is only
 * imported into an empty history.
 */

import * as db from './db.js';
import { getSettings, updateSettings } from './settings.js';
import { normalizeRef } from './reconcile.js';

export const BACKUP_FORMAT = 'dockpull-backup';
export const BACKUP_VERSION = 1;
const MAX_HISTORY = 5000;

export function buildBackup({ appVersion = null } = {}) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    settings: getSettings(),
    pinned: db.getPinned(),
    history: db.getHistory({ limit: MAX_HISTORY, offset: 0 }).map((r) => ({
      container_name: r.container_name,
      image: r.image,
      old_digest: r.old_digest,
      new_digest: r.new_digest,
      old_version: r.old_version ?? null,
      new_version: r.new_version ?? null,
      status: r.status,
      message: r.message,
      created_at: r.created_at,
    })),
  };
}

class RestoreError extends Error {
  constructor(message) {
    super(message);
    this.code = 'invalid_backup';
  }
}

const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : null);

function cleanHistoryRow(r) {
  if (!r || typeof r !== 'object') return null;
  const name = str(r.container_name, 255);
  const image = str(r.image, 512);
  const status = r.status === 'success' || r.status === 'failure' ? r.status : null;
  const created = str(r.created_at, 40);
  if (!name || !image || !status || !created || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(created)) return null;
  return {
    container_name: name,
    image,
    old_digest: str(r.old_digest, 100),
    new_digest: str(r.new_digest, 100),
    old_version: str(r.old_version, 100),
    new_version: str(r.new_version, 100),
    status,
    message: str(r.message, 4000),
    created_at: created,
  };
}

/**
 * Apply a backup. Settings are validated as a whole first (all-or-nothing);
 * pins and history rows that don't validate are skipped and counted.
 *
 * @returns {{ settings: number, pinned: number, history: number, skipped: number, historySkippedBecauseNotEmpty: boolean }}
 * @throws {RestoreError} if it isn't a DockPull backup or settings are invalid.
 */
export function restoreBackup(backup) {
  if (!backup || typeof backup !== 'object' || backup.format !== BACKUP_FORMAT) {
    throw new RestoreError("That file isn't a DockPull backup.");
  }
  if (backup.version !== BACKUP_VERSION) {
    throw new RestoreError(`Unsupported backup version ${backup.version}.`);
  }

  let skipped = 0;
  let settingsCount = 0;
  if (backup.settings && typeof backup.settings === 'object') {
    try {
      updateSettings(backup.settings); // validates every known key; ignores unknown
      settingsCount = Object.keys(backup.settings).length;
    } catch (err) {
      throw new RestoreError(`Backup has an invalid setting: ${err.message}`);
    }
  }

  let pinned = 0;
  for (const ref of Array.isArray(backup.pinned) ? backup.pinned : []) {
    try {
      db.pin(normalizeRef(String(ref)));
      pinned += 1;
    } catch {
      skipped += 1;
    }
  }

  let history = 0;
  const historySkippedBecauseNotEmpty = db.countHistory() > 0;
  if (!historySkippedBecauseNotEmpty && Array.isArray(backup.history)) {
    const rows = [];
    for (const r of backup.history.slice(0, MAX_HISTORY)) {
      const clean = cleanHistoryRow(r);
      if (clean) rows.push(clean);
      else skipped += 1;
    }
    db.importHistory(rows.reverse()); // exported newest-first; insert oldest-first
    history = rows.length;
  }

  return { settings: settingsCount, pinned, history, skipped, historySkippedBecauseNotEmpty };
}

export default { buildBackup, restoreBackup, BACKUP_FORMAT, BACKUP_VERSION };
