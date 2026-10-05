import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dockpull-backup-'));
const db = await import('../src/db.js');
const { buildBackup, restoreBackup } = await import('../src/backup.js');
const { updateSettings, getSettings } = await import('../src/settings.js');

test('backup round-trips settings, pins and history into a fresh install', () => {
  updateSettings({ scheduledCheckTime: '06:15', tagUpdates: 'major' });
  db.pin('docker.io/library/postgres:16');
  db.recordUpdate({ container_name: 'db', image: 'postgres:16', status: 'success', message: 'ok', old_version: '16.3', new_version: '16.4' });
  const backup = JSON.parse(JSON.stringify(buildBackup({ appVersion: '1.2.3' })));
  assert.equal(backup.format, 'dockpull-backup');
  assert.equal(backup.history.length, 1);

  // "New host": wipe everything, then restore.
  db.clearHistory();
  db.unpin('docker.io/library/postgres:16');
  updateSettings({ scheduledCheckTime: '09:00', tagUpdates: 'minor' });

  const r = restoreBackup(backup);
  assert.equal(r.pinned, 1);
  assert.equal(r.history, 1);
  assert.equal(getSettings().scheduledCheckTime, '06:15');
  assert.equal(getSettings().tagUpdates, 'major');
  assert.deepEqual(db.getPinned(), ['docker.io/library/postgres:16']);
  assert.equal(db.getHistory({})[0].new_version, '16.4');

  // Restoring again doesn't duplicate history.
  const again = restoreBackup(backup);
  assert.equal(again.history, 0);
  assert.equal(again.historySkippedBecauseNotEmpty, true);
  assert.equal(db.countHistory(), 1);
});

test('restore rejects non-backups and invalid settings without partial writes', () => {
  assert.throws(() => restoreBackup({ hello: 1 }), { code: 'invalid_backup' });
  assert.throws(() => restoreBackup({ format: 'dockpull-backup', version: 99 }), { code: 'invalid_backup' });
  const before = getSettings().scheduledCheckTime;
  assert.throws(
    () => restoreBackup({ format: 'dockpull-backup', version: 1, settings: { scheduledCheckTime: '99:99' }, pinned: ['x:1'] }),
    { code: 'invalid_backup' }
  );
  assert.equal(getSettings().scheduledCheckTime, before);
});

test('restore skips junk pins and history rows', () => {
  db.clearHistory();
  const r = restoreBackup({
    format: 'dockpull-backup',
    version: 1,
    pinned: ['', 'redis:7'],
    history: [{ container_name: 'x' }, { container_name: 'a', image: 'b', status: 'success', created_at: '2026-01-01 00:00:00' }],
  });
  assert.equal(r.pinned, 1);
  assert.equal(r.history, 1);
  assert.equal(r.skipped, 2);
});

test('restore with one bad setting writes none of them', () => {
  const before = getSettings();
  assert.throws(
    () => restoreBackup({ format: 'dockpull-backup', version: 1, settings: { scheduledCheckTime: '05:00', tagUpdates: 'nope' } }),
    { code: 'invalid_backup' }
  );
  assert.equal(getSettings().scheduledCheckTime, before.scheduledCheckTime);
});
