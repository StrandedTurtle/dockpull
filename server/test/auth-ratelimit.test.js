import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLockedOut, recordLoginFailure, clearLoginFailures } from '../src/auth.js';

// Each test uses a unique IP because the limiter state is a shared module-level
// map (mirrors how it works at runtime: per-client-IP).

test('not locked out before reaching the failure threshold', () => {
  const ip = 'test-ip-under-threshold';
  for (let i = 0; i < 9; i += 1) recordLoginFailure(ip);
  assert.equal(isLockedOut(ip), false);
});

test('locked out once failures reach the threshold (10)', () => {
  const ip = 'test-ip-threshold';
  for (let i = 0; i < 10; i += 1) recordLoginFailure(ip);
  assert.equal(isLockedOut(ip), true);
});

test('clearLoginFailures resets the counter', () => {
  const ip = 'test-ip-clear';
  for (let i = 0; i < 10; i += 1) recordLoginFailure(ip);
  assert.equal(isLockedOut(ip), true);
  clearLoginFailures(ip);
  assert.equal(isLockedOut(ip), false);
});

test('failures older than the window do not accumulate into a lockout', () => {
  const ip = 'test-ip-window';
  const t0 = 1_000_000;
  for (let i = 0; i < 9; i += 1) recordLoginFailure(ip, t0);
  // One more, but well past the rolling window — should start a fresh count.
  const later = t0 + 16 * 60 * 1000;
  recordLoginFailure(ip, later);
  assert.equal(isLockedOut(ip, later), false);
});

test('lockout expires after the lockout duration', () => {
  const ip = 'test-ip-expiry';
  const t0 = 5_000_000;
  for (let i = 0; i < 10; i += 1) recordLoginFailure(ip, t0);
  assert.equal(isLockedOut(ip, t0), true);
  // 16 minutes later (lockout is 15m) it should be clear again.
  assert.equal(isLockedOut(ip, t0 + 16 * 60 * 1000), false);
});
