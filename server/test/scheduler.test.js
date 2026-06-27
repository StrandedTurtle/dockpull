import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// scheduler.js transitively imports db.js, which creates config.DATA_DIR at
// load time — point it at a throwaway dir BEFORE importing (CI can't mkdir /data).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dockpull-sched-'));
process.env.DATA_DIR = tmp;

const { msUntilNext, selectNotifyTargets } = await import('../src/scheduler.js');

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

const identity = (ref) => ref;

test('selectNotifyTargets: lists every pending non-pinned update, not just unannounced ones', () => {
  const items = [
    { image: 'a', updateAvailable: true, pinned: false },
    { image: 'b', updateAvailable: true, pinned: false },
    { image: 'c', updateAvailable: false, pinned: false },
    { image: 'd', updateAvailable: true, pinned: true },
  ];
  // 'a' was already announced (not in unnotified); 'b' is new.
  const { toNotify, hasNew } = selectNotifyTargets(items, new Set(['b']), identity);
  assert.deepEqual(toNotify.map((i) => i.image), ['a', 'b']);
  assert.equal(hasNew, true);
});

test('selectNotifyTargets: hasNew is false when nothing pending is unannounced', () => {
  const items = [{ image: 'a', updateAvailable: true, pinned: false }];
  const { toNotify, hasNew } = selectNotifyTargets(items, new Set(), identity);
  assert.deepEqual(toNotify.map((i) => i.image), ['a']);
  assert.equal(hasNew, false);
});

test('selectNotifyTargets: empty when nothing has an unpinned update', () => {
  const items = [
    { image: 'a', updateAvailable: false, pinned: false },
    { image: 'b', updateAvailable: true, pinned: true },
  ];
  const { toNotify, hasNew } = selectNotifyTargets(items, new Set(['a', 'b']), identity);
  assert.deepEqual(toNotify, []);
  assert.equal(hasNew, false);
});

test('selectNotifyTargets: a normalizeRef failure for one item does not throw', () => {
  const items = [{ image: 'bad-ref', updateAvailable: true, pinned: false }];
  const throwing = () => {
    throw new Error('bad ref');
  };
  const { toNotify, hasNew } = selectNotifyTargets(items, new Set(['bad-ref']), throwing);
  assert.deepEqual(toNotify.map((i) => i.image), ['bad-ref']);
  assert.equal(hasNew, false);
});
