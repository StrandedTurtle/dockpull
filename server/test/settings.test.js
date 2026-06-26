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

test('settings: defaults when nothing stored', () => {
  assert.deepEqual(getSettings(), {
    defaultFilter: 'updates',
    autoCheckOnOpen: true,
    backgroundCheckEnabled: true,
    backgroundCheckIntervalHours: 6,
    discordEnabled: false,
    discordWebhookUrl: '',
  });
});

test('settings: persists and coerces booleans/filter', () => {
  const s = updateSettings({ defaultFilter: 'all', autoCheckOnOpen: false });
  assert.equal(s.defaultFilter, 'all');
  assert.equal(s.autoCheckOnOpen, false);
  assert.equal(getSettings().defaultFilter, 'all');
});

test('settings: rejects invalid known values', () => {
  assert.throws(() => updateSettings({ defaultFilter: 'bogus' }), /invalid value/);
});

test('settings: ignores unknown keys', () => {
  assert.doesNotThrow(() => updateSettings({ somethingUnknown: 'x' }));
});

test('settings: interval bounds enforced', () => {
  assert.equal(updateSettings({ backgroundCheckIntervalHours: 12 }).backgroundCheckIntervalHours, 12);
  assert.throws(() => updateSettings({ backgroundCheckIntervalHours: 0 }), /invalid value/);
  assert.throws(() => updateSettings({ backgroundCheckIntervalHours: 999 }), /invalid value/);
});

test('settings: webhook url validated, empty allowed', () => {
  const s = updateSettings({ discordWebhookUrl: 'https://discord.com/api/webhooks/1/abc' });
  assert.equal(s.discordWebhookUrl, 'https://discord.com/api/webhooks/1/abc');
  assert.throws(() => updateSettings({ discordWebhookUrl: 'not-a-url' }), /invalid value/);
  assert.equal(updateSettings({ discordWebhookUrl: '' }).discordWebhookUrl, '');
});
