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

import { parseVersionTag, findNewerTags } from '../src/version.js';

test('parseVersionTag: versions vs non-versions', () => {
  assert.equal(parseVersionTag('latest'), null);
  assert.equal(parseVersionTag('main'), null);
  assert.equal(parseVersionTag('a1b2c3d'), null);
  assert.equal(parseVersionTag('1234abcd'), null);
  assert.deepEqual(parseVersionTag('v1.2.3').nums, [1, 2, 3]);
  assert.equal(parseVersionTag('16.3-alpine').shape, parseVersionTag('16.4-alpine').shape);
  assert.notEqual(parseVersionTag('16.3-alpine').shape, parseVersionTag('16.4').shape);
  assert.notEqual(parseVersionTag('1.2.3').shape, parseVersionTag('1.2.4-rc1').shape);
});

test('findNewerTags: same-major update and next major, shape-matched', () => {
  const tags = ['16.2', '16.3', '16.4', '16.10', '17.0', '17.1', '16.4-alpine', '17.0-alpine', '16.5-rc1', 'latest', '16', '17'];
  assert.deepEqual(findNewerTags('16.3', tags), { sameMajor: '16.10', nextMajor: '17.1' });
  assert.deepEqual(findNewerTags('16.3-alpine', tags), { sameMajor: '16.4-alpine', nextMajor: '17.0-alpine' });
  assert.deepEqual(findNewerTags('16', tags), { sameMajor: null, nextMajor: '17' }); // floating major tag
  assert.deepEqual(findNewerTags('17.1', tags), { sameMajor: null, nextMajor: null });
  assert.deepEqual(findNewerTags('latest', tags), { sameMajor: null, nextMajor: null });
});

test('findNewerTags: linuxserver-style build suffixes and v-prefixes', () => {
  const ls = ['4.0.14.2939-ls283', '4.0.14.2939-ls284', '4.0.15.2941-ls285', '5.0.0.1-ls1', 'develop'];
  assert.deepEqual(findNewerTags('4.0.14.2939-ls283', ls), { sameMajor: '4.0.15.2941-ls285', nextMajor: '5.0.0.1-ls1' });
  assert.deepEqual(findNewerTags('v1.2.0', ['v1.2.1', '1.3.0', 'v2.0.0']), { sameMajor: 'v1.2.1', nextMajor: 'v2.0.0' });
});
