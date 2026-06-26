import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msUntilNext } from '../src/scheduler.js';

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
