import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

if (!fs.existsSync(config.DATA_DIR)) {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
}

const dbPath = path.join(config.DATA_DIR, 'app.db');
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS update_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image TEXT NOT NULL,
  normalized_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  digest TEXT,
  raw_json TEXT,
  received_at TEXT DEFAULT (datetime('now')),
  resolved INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS update_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  container_name TEXT NOT NULL,
  image TEXT NOT NULL,
  old_digest TEXT, new_digest TEXT,
  status TEXT NOT NULL CHECK(status IN ('success','failure')),
  message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pinned (
  ref TEXT PRIMARY KEY,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS image_versions (
  digest TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS rollback_points (
  container_name TEXT PRIMARY KEY,
  image_id TEXT NOT NULL,
  image_ref TEXT,
  old_digest TEXT,
  old_version TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tag_updates (
  normalized_ref TEXT PRIMARY KEY,
  current_tag TEXT NOT NULL,
  same_major TEXT,
  next_major TEXT,
  dismissed_tag TEXT,
  notified_key TEXT,
  checked_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_ref ON update_events(normalized_ref, resolved);
CREATE INDEX IF NOT EXISTS idx_history_created ON update_history(created_at DESC);
`);

// Migrations: add `notified` (dedupe Discord notifications),
// `available_version` (the OCI version label of the remote/available image,
// best-effort) and `breaking` (release notes between running and available
// versions mention breaking changes, best-effort) to update_events.
{
  const cols = db.prepare('PRAGMA table_info(update_events)').all().map((col) => col.name);
  if (!cols.includes('notified')) {
    db.exec('ALTER TABLE update_events ADD COLUMN notified INTEGER DEFAULT 0');
  }
  if (!cols.includes('available_version')) {
    db.exec('ALTER TABLE update_events ADD COLUMN available_version TEXT');
  }
  if (!cols.includes('breaking')) {
    db.exec('ALTER TABLE update_events ADD COLUMN breaking INTEGER DEFAULT 0');
  }
  // `skipped`: the user dismissed this specific available build ("Skip this
  // update"). A newer build creates a fresh, unskipped event.
  if (!cols.includes('skipped')) {
    db.exec('ALTER TABLE update_events ADD COLUMN skipped INTEGER DEFAULT 0');
  }
}

// rollback_points: a tag switch also changed the compose file; remember how,
// so reverting can put the old tag back.
{
  const cols = db.prepare('PRAGMA table_info(rollback_points)').all().map((col) => col.name);
  if (!cols.includes('compose_edit')) db.exec('ALTER TABLE rollback_points ADD COLUMN compose_edit TEXT');
}

// update_history: remember versions on the row itself, for when an image's
// digest is unknown (so the digest→version lookup can't recover them later).
{
  const cols = db.prepare('PRAGMA table_info(update_history)').all().map((col) => col.name);
  if (!cols.includes('old_version')) db.exec('ALTER TABLE update_history ADD COLUMN old_version TEXT');
  if (!cols.includes('new_version')) db.exec('ALTER TABLE update_history ADD COLUMN new_version TEXT');
}

const stmts = {
  importHistoryRow: db.prepare(`
    INSERT INTO update_history (container_name, image, old_digest, new_digest, old_version, new_version, status, message, created_at)
    VALUES (@container_name, @image, @old_digest, @new_digest, @old_version, @new_version, @status, @message, @created_at)
  `),
  countHistory: db.prepare(`SELECT COUNT(*) AS n FROM update_history`),
  setTagUpdate: db.prepare(`
    INSERT INTO tag_updates (normalized_ref, current_tag, same_major, next_major, checked_at)
    VALUES (@normalized_ref, @current_tag, @same_major, @next_major, datetime('now'))
    ON CONFLICT(normalized_ref) DO UPDATE SET
      current_tag = excluded.current_tag,
      same_major = excluded.same_major,
      next_major = excluded.next_major,
      checked_at = excluded.checked_at
  `),
  getTagUpdate: db.prepare(`SELECT * FROM tag_updates WHERE normalized_ref = ? LIMIT 1`),
  getAllTagUpdates: db.prepare(`SELECT * FROM tag_updates`),
  deleteTagUpdate: db.prepare(`DELETE FROM tag_updates WHERE normalized_ref = ?`),
  dismissTag: db.prepare(`UPDATE tag_updates SET dismissed_tag = ? WHERE normalized_ref = ?`),
  markTagNotified: db.prepare(`UPDATE tag_updates SET notified_key = ? WHERE normalized_ref = ?`),
  recordEvent: db.prepare(`
    INSERT INTO update_events (image, normalized_ref, status, digest, available_version, breaking, raw_json)
    VALUES (@image, @normalized_ref, @status, @digest, @available_version, @breaking, @raw_json)
  `),
  latestUnresolvedEventForRef: db.prepare(`
    SELECT * FROM update_events
    WHERE normalized_ref = ? AND resolved = 0
    ORDER BY id DESC LIMIT 1
  `),
  resolveEventsForRef: db.prepare(`
    UPDATE update_events SET resolved = 1
    WHERE normalized_ref = ? AND resolved = 0
  `),
  setLatestEventSkipped: db.prepare(`
    UPDATE update_events SET skipped = ?
    WHERE id = (
      SELECT id FROM update_events
      WHERE normalized_ref = ? AND resolved = 0
      ORDER BY id DESC LIMIT 1
    )
  `),
  updateEventAvailableVersion: db.prepare(`
    UPDATE update_events SET available_version = ?
    WHERE normalized_ref = ? AND digest = ? AND resolved = 0
  `),
  setImageVersion: db.prepare(`
    INSERT INTO image_versions (digest, version, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(digest) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at
  `),
  getImageVersion: db.prepare(`
    SELECT version FROM image_versions WHERE digest = ? LIMIT 1
  `),
  setMeta: db.prepare(`
    INSERT INTO app_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  getMeta: db.prepare(`
    SELECT value FROM app_meta WHERE key = ? LIMIT 1
  `),
  setRollbackPoint: db.prepare(`
    INSERT INTO rollback_points (container_name, image_id, image_ref, old_digest, old_version, compose_edit, created_at)
    VALUES (@container_name, @image_id, @image_ref, @old_digest, @old_version, @compose_edit, datetime('now'))
    ON CONFLICT(container_name) DO UPDATE SET
      image_id = excluded.image_id,
      image_ref = excluded.image_ref,
      old_digest = excluded.old_digest,
      old_version = excluded.old_version,
      compose_edit = excluded.compose_edit,
      created_at = excluded.created_at
  `),
  getRollbackPoint: db.prepare(`
    SELECT * FROM rollback_points WHERE container_name = ? LIMIT 1
  `),
  getAllRollbackPoints: db.prepare(`
    SELECT container_name, image_id FROM rollback_points
  `),
  deleteRollbackPoint: db.prepare(`
    DELETE FROM rollback_points WHERE container_name = ?
  `),
  recordUpdate: db.prepare(`
    INSERT INTO update_history (container_name, image, old_digest, new_digest, old_version, new_version, status, message)
    VALUES (@container_name, @image, @old_digest, @new_digest, @old_version, @new_version, @status, @message)
  `),
  getHistoryAll: db.prepare(`
    SELECT * FROM update_history
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `),
  getHistoryByContainer: db.prepare(`
    SELECT * FROM update_history
    WHERE container_name = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `),
  clearHistory: db.prepare(`
    DELETE FROM update_history
  `),
  pin: db.prepare(`
    INSERT INTO pinned (ref) VALUES (?)
    ON CONFLICT(ref) DO NOTHING
  `),
  unpin: db.prepare(`
    DELETE FROM pinned WHERE ref = ?
  `),
  getPinned: db.prepare(`
    SELECT ref FROM pinned ORDER BY created_at DESC
  `),
  isPinned: db.prepare(`
    SELECT 1 FROM pinned WHERE ref = ? LIMIT 1
  `),
  getSetting: db.prepare(`
    SELECT value FROM settings WHERE key = ? LIMIT 1
  `),
  getAllSettings: db.prepare(`
    SELECT key, value FROM settings
  `),
  setSetting: db.prepare(`
    INSERT INTO settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  getUnnotifiedRefs: db.prepare(`
    SELECT DISTINCT normalized_ref FROM update_events WHERE resolved = 0 AND notified = 0
  `),
  markRefNotified: db.prepare(`
    UPDATE update_events SET notified = 1 WHERE resolved = 0 AND normalized_ref = ?
  `),
};

export function recordEvent({ image, normalized_ref, status, digest, available_version, breaking, raw_json }) {
  return stmts.recordEvent.run({
    image,
    normalized_ref,
    status,
    digest: digest ?? null,
    available_version: available_version ?? null,
    breaking: breaking ? 1 : 0,
    raw_json: raw_json ?? null,
  });
}

export function latestUnresolvedEventForRef(normalized_ref) {
  return stmts.latestUnresolvedEventForRef.get(normalized_ref);
}

export function resolveEventsForRef(normalized_ref) {
  return stmts.resolveEventsForRef.run(normalized_ref);
}

/**
 * Skip (or un-skip) the currently offered update for a ref — i.e. its latest
 * unresolved event. Returns true if there was one to change.
 */
export function setLatestEventSkipped(normalized_ref, skipped) {
  return stmts.setLatestEventSkipped.run(skipped ? 1 : 0, normalized_ref).changes > 0;
}

/**
 * Newer version TAGS for a ref (e.g. running postgres:16.3, registry has 16.4
 * and 17.1). Rows with nothing newer are removed. The dismissed tag survives
 * re-checks so a skipped tag stays hidden until an even newer one appears.
 */
export function setTagUpdate({ normalized_ref, current_tag, same_major, next_major }) {
  if (!same_major && !next_major) return stmts.deleteTagUpdate.run(normalized_ref);
  return stmts.setTagUpdate.run({ normalized_ref, current_tag, same_major: same_major ?? null, next_major: next_major ?? null });
}

export function getTagUpdate(normalized_ref) {
  return stmts.getTagUpdate.get(normalized_ref) || null;
}

export function getAllTagUpdates() {
  return stmts.getAllTagUpdates.all();
}

export function dismissTag(normalized_ref, tag) {
  return stmts.dismissTag.run(tag ?? null, normalized_ref).changes > 0;
}

export function markTagNotified(normalized_ref, key) {
  return stmts.markTagNotified.run(key ?? null, normalized_ref);
}

export function updateEventAvailableVersion(normalized_ref, digest, available_version) {
  return stmts.updateEventAvailableVersion.run(available_version ?? null, normalized_ref, digest);
}

/**
 * Remember a human-readable version for a specific image digest, so the
 * dashboard can show a real version number even for images whose own labels
 * are junk (e.g. `:latest` + `org.opencontainers.image.version=main`).
 */
export function setImageVersion(digest, version) {
  if (!digest || !version) return undefined;
  return stmts.setImageVersion.run(digest, version);
}

export function getImageVersion(digest) {
  if (!digest) return null;
  const row = stmts.getImageVersion.get(digest);
  return row ? row.version : null;
}

/** Small key/value JSON store for app-level metadata (e.g. last check status). */
export function setMeta(key, value) {
  return stmts.setMeta.run(key, JSON.stringify(value));
}

export function getMeta(key) {
  const row = stmts.getMeta.get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

/**
 * Remember how to undo the most recent update of a container (the previous
 * local image ID + what it was), so the dashboard can offer a one-click revert.
 */
export function setRollbackPoint({ container_name, image_id, image_ref = null, old_digest = null, old_version = null, compose_edit = null }) {
  if (!container_name || !image_id) return undefined;
  return stmts.setRollbackPoint.run({
    container_name,
    image_id,
    image_ref,
    old_digest,
    old_version,
    compose_edit: compose_edit ? JSON.stringify(compose_edit) : null,
  });
}

export function getRollbackPoint(container_name) {
  if (!container_name) return null;
  const row = stmts.getRollbackPoint.get(container_name);
  if (!row) return null;
  let composeEdit = null;
  try {
    composeEdit = row.compose_edit ? JSON.parse(row.compose_edit) : null;
  } catch {
    composeEdit = null;
  }
  return { ...row, compose_edit: composeEdit };
}

export function deleteRollbackPoint(container_name) {
  return stmts.deleteRollbackPoint.run(container_name);
}

/**
 * Forget rollback points whose saved image is gone (e.g. it was pruned), so the
 * dashboard stops offering a Revert that can't work. `shortIds` are 12-char
 * image IDs. Returns the affected container names.
 */
export function deleteRollbackPointsForImages(shortIds) {
  const gone = new Set(shortIds || []);
  if (gone.size === 0) return [];
  const affected = stmts.getAllRollbackPoints
    .all()
    .filter((r) => gone.has(String(r.image_id || '').replace(/^sha256:/, '').slice(0, 12)))
    .map((r) => r.container_name);
  for (const name of affected) stmts.deleteRollbackPoint.run(name);
  return affected;
}

/**
 * Every container's remembered previous image ID (container_name, image_id
 * pairs only) — used to attribute a dangling image back to the container it
 * was replaced on, for the prune preview. One row per container (the most
 * recent update only); see setRollbackPoint.
 */
export function getAllRollbackPoints() {
  return stmts.getAllRollbackPoints.all();
}

export function recordUpdate({ container_name, image, old_digest, new_digest, old_version, new_version, status, message }) {
  return stmts.recordUpdate.run({
    container_name,
    image,
    old_digest: old_digest ?? null,
    new_digest: new_digest ?? null,
    old_version: old_version ?? null,
    new_version: new_version ?? null,
    status,
    message: message ?? null,
  });
}

export function getHistory({ containerName, limit = 50, offset = 0 } = {}) {
  if (containerName) {
    return stmts.getHistoryByContainer.all(containerName, limit, offset);
  }
  return stmts.getHistoryAll.all(limit, offset);
}

export function countHistory() {
  return stmts.countHistory.get().n;
}

const importHistoryTxn = db.transaction((rows) => {
  for (const r of rows) stmts.importHistoryRow.run(r);
});

/** Insert history rows from a backup (already validated), in one transaction. */
export function importHistory(rows) {
  importHistoryTxn(rows);
}

/** Delete all update-history rows. Returns the better-sqlite3 run info. */
export function clearHistory() {
  return stmts.clearHistory.run();
}

export function pin(ref) {
  return stmts.pin.run(ref);
}

export function unpin(ref) {
  return stmts.unpin.run(ref);
}

export function getPinned() {
  return stmts.getPinned.all().map((row) => row.ref);
}

export function isPinned(ref) {
  return stmts.isPinned.get(ref) !== undefined;
}

export function getSetting(key) {
  const row = stmts.getSetting.get(key);
  return row ? row.value : undefined;
}

export function getAllSettings() {
  const out = {};
  for (const row of stmts.getAllSettings.all()) {
    out[row.key] = row.value;
  }
  return out;
}

export function setSetting(key, value) {
  return stmts.setSetting.run({ key, value: value == null ? null : String(value) });
}

export function getUnnotifiedRefs() {
  return stmts.getUnnotifiedRefs.all().map((r) => r.normalized_ref);
}

const markRefsNotifiedTxn = db.transaction((refs) => {
  for (const ref of refs) stmts.markRefNotified.run(ref);
});

export function markRefsNotified(refs) {
  if (Array.isArray(refs) && refs.length) markRefsNotifiedTxn(refs);
}

export default db;
