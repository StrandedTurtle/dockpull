import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortImageId } from '../src/docker.js';

test('shortImageId: strips the sha256: prefix and truncates to 12 chars', () => {
  assert.equal(
    shortImageId('sha256:a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9'),
    'a1b2c3d4e5f6'
  );
});

test('shortImageId: already-short IDs pass through unchanged', () => {
  assert.equal(shortImageId('a1b2c3d4e5f6'), 'a1b2c3d4e5f6');
});

test('shortImageId: empty / missing input returns an empty string', () => {
  assert.equal(shortImageId(''), '');
  assert.equal(shortImageId(null), '');
  assert.equal(shortImageId(undefined), '');
});
