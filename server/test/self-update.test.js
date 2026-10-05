import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newerSelfReleases } from '../src/self-update.js';

const rel = (tag, extra = {}) => ({ tag_name: tag, html_url: `u/${tag}`, ...extra });

test('newerSelfReleases: only stable releases newer than the running version, newest first', () => {
  const releases = [rel('v1.8.0'), rel('v1.9.0-rc.1', { prerelease: true }), rel('v1.7.2'), rel('v1.7.1'), rel('v2.0.0', { draft: true })];
  assert.deepEqual(newerSelfReleases(releases, '1.7.1').map((r) => r.tag_name), ['v1.8.0', 'v1.7.2']);
  assert.deepEqual(newerSelfReleases(releases, '1.8.0'), []);
});

test('newerSelfReleases: unknown/dev versions and bad input never show a banner', () => {
  assert.deepEqual(newerSelfReleases([rel('v9.9.9')], 'unknown'), []);
  assert.deepEqual(newerSelfReleases(null, '1.0.0'), []);
  assert.deepEqual(newerSelfReleases([rel('nightly')], '1.0.0'), []);
});
