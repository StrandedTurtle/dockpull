import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point DATA_DIR at a throwaway dir BEFORE importing db/settings — db.js
// creates the SQLite file from config.DATA_DIR at import time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diun-settings-'));
process.env.DATA_DIR = tmp;

const { getSettings, updateSettings } = await import('../src/settings.js');
const db = await import('../src/db.js');

test('settings: defaults when nothing stored', () => {
  assert.deepEqual(getSettings(), { defaultFilter: 'updates', autoCheckOnOpen: true });
});

test('settings: updateSettings persists and coerces booleans', () => {
  const s = updateSettings({ defaultFilter: 'all', autoCheckOnOpen: false });
  assert.equal(s.defaultFilter, 'all');
  assert.equal(s.autoCheckOnOpen, false);
  assert.deepEqual(getSettings(), { defaultFilter: 'all', autoCheckOnOpen: false });
});

test('settings: rejects invalid known values', () => {
  assert.throws(() => updateSettings({ defaultFilter: 'bogus' }), /invalid value/);
});

test('settings: ignores unknown keys', () => {
  assert.doesNotThrow(() => updateSettings({ somethingUnknown: 'x' }));
});

test('hidden: hide/isHidden/unhide roundtrip', () => {
  assert.equal(db.isHidden('cadvisor'), false);
  db.hide('cadvisor');
  assert.equal(db.isHidden('cadvisor'), true);
  assert.deepEqual(db.getHidden(), ['cadvisor']);
  db.hide('cadvisor'); // idempotent
  assert.equal(db.getHidden().length, 1);
  db.unhide('cadvisor');
  assert.equal(db.isHidden('cadvisor'), false);
});
