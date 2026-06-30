import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMeaningfulVersion } from '../src/version.js';

test('isMeaningfulVersion: accepts real versions', () => {
  for (const v of ['1.68.1', 'v1.68.1', '1.68', '2024.1.1', '10.9.0', 'v2', '1.0.0-rc.1']) {
    assert.equal(isMeaningfulVersion(v), true, `${v} should be meaningful`);
  }
});

test('isMeaningfulVersion: rejects channel/branch stopwords', () => {
  for (const v of ['main', 'master', 'latest', 'edge', 'stable', 'nightly', 'develop', 'HEAD', 'Latest', 'release']) {
    assert.equal(isMeaningfulVersion(v), false, `${v} should be junk`);
  }
});

test('isMeaningfulVersion: rejects shas and digests', () => {
  assert.equal(isMeaningfulVersion('a1b2c3d'), false);
  assert.equal(isMeaningfulVersion('57ef0af4a252ea39727caeba7e13587dabc6254e'), false);
  assert.equal(isMeaningfulVersion('sha256:abc123'), false);
});

test('isMeaningfulVersion: rejects empty / non-strings', () => {
  assert.equal(isMeaningfulVersion(''), false);
  assert.equal(isMeaningfulVersion('   '), false);
  assert.equal(isMeaningfulVersion(null), false);
  assert.equal(isMeaningfulVersion(undefined), false);
  assert.equal(isMeaningfulVersion(123), false);
});
