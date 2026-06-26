import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// scheduler.js transitively imports db.js, which creates config.DATA_DIR at
// load time — point it at a throwaway dir BEFORE importing (CI can't mkdir /data).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dockpull-sched-'));
process.env.DATA_DIR = tmp;

const { msUntilNext } = await import('../src/scheduler.js');

test('msUntilNext: later today', () => {
  const now = new Date(2026, 0, 1, 8, 0, 0); // 08:00
  assert.equal(msUntilNext('09:00', now), 60 * 60 * 1000); // 1h
});

test('msUntilNext: rolls to tomorrow when time has passed', () => {
  const now = new Date(2026, 0, 1, 10, 0, 0); // 10:00
  assert.equal(msUntilNext('09:00', now), 23 * 60 * 60 * 1000); // 23h
});

test('msUntilNext: invalid string falls back to 09:00', () => {
  const now = new Date(2026, 0, 1, 8, 0, 0);
  assert.equal(msUntilNext('garbage', now), 60 * 60 * 1000);
});
