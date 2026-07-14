import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGitHubRepo,
  selectNewerReleases,
  buildRegistryLink,
  pickLatestReleaseTag,
  detectBreakingChanges,
} from '../src/changelog.js';

test('parseGitHubRepo: extracts owner/repo, strips .git', () => {
  assert.deepEqual(parseGitHubRepo('https://github.com/jellyfin/jellyfin'), {
    owner: 'jellyfin',
    repo: 'jellyfin',
  });
  assert.deepEqual(parseGitHubRepo('git+https://github.com/foo/bar.git'), {
    owner: 'foo',
    repo: 'bar',
  });
  assert.equal(parseGitHubRepo('https://gitlab.com/foo/bar'), null);
  assert.equal(parseGitHubRepo(null), null);
});

test('selectNewerReleases: returns releases newer than current version', () => {
  const releases = [
    { tag_name: 'v3.0.0' },
    { tag_name: 'v2.1.0' },
    { tag_name: 'v2.0.0' },
    { tag_name: 'v1.0.0' },
  ];
  // running 2.0.0 -> show 3.0.0 and 2.1.0 (stops at the match)
  const out = selectNewerReleases(releases, '2.0.0');
  assert.deepEqual(out.map((r) => r.tag_name), ['v3.0.0', 'v2.1.0']);
});

test('selectNewerReleases: up to date -> empty', () => {
  const releases = [{ tag_name: 'v2.0.0' }, { tag_name: 'v1.0.0' }];
  assert.deepEqual(selectNewerReleases(releases, 'v2.0.0'), []);
});

test('selectNewerReleases: unknown current version -> recent few', () => {
  const releases = [{ tag_name: 'a' }, { tag_name: 'b' }, { tag_name: 'c' }];
  assert.equal(selectNewerReleases(releases, null).length, 3);
});

test('pickLatestReleaseTag: newest non-draft, non-prerelease tag', () => {
  const releases = [
    { tag_name: 'v2.0.0-rc.1', prerelease: true },
    { tag_name: 'v1.9.0-draft', draft: true },
    { tag_name: 'v1.68.1' },
    { tag_name: 'v1.68.0' },
  ];
  assert.equal(pickLatestReleaseTag(releases), 'v1.68.1');
});

test('pickLatestReleaseTag: falls back to name; null when none', () => {
  assert.equal(pickLatestReleaseTag([{ name: 'Release 5.0' }]), 'Release 5.0');
  assert.equal(pickLatestReleaseTag([{ tag_name: 'v1', draft: true }]), null);
  assert.equal(pickLatestReleaseTag([]), null);
  assert.equal(pickLatestReleaseTag(null), null);
});

test('detectBreakingChanges: matches breaking-change signals in body or name', () => {
  assert.equal(
    detectBreakingChanges([{ tag_name: 'v2.0.0', body: 'BREAKING CHANGE: config format changed' }]),
    true
  );
  assert.equal(detectBreakingChanges([{ name: 'v3.0.0 — breaking changes ahead', body: '' }]), true);
  assert.equal(detectBreakingChanges([{ tag_name: 'v1.5.0', body: 'Migration required for the new schema' }]), true);
  assert.equal(detectBreakingChanges([{ tag_name: 'v1.4.0', body: 'The old API is deprecated' }]), true);
  assert.equal(detectBreakingChanges([{ tag_name: 'v1.3.0', body: 'Action required: rotate your tokens' }]), true);
});

test('detectBreakingChanges: does not match unrelated text', () => {
  assert.equal(detectBreakingChanges([{ tag_name: 'v1.0.1', body: 'fixed bug in navbar' }]), false);
  // \b boundary: "unbreakable" must not trip the "breaking" signal.
  assert.equal(detectBreakingChanges([{ tag_name: 'v1.0.2', body: 'now with unbreakable encryption' }]), false);
});

test('detectBreakingChanges: handles null/empty input', () => {
  assert.equal(detectBreakingChanges(null), false);
  assert.equal(detectBreakingChanges(undefined), false);
  assert.equal(detectBreakingChanges([]), false);
  assert.equal(detectBreakingChanges('not an array'), false);
});

test('buildRegistryLink: docker hub official + namespaced, ghcr', () => {
  assert.deepEqual(buildRegistryLink('nginx:latest'), {
    url: 'https://hub.docker.com/_/nginx',
    label: 'Docker Hub',
  });
  assert.deepEqual(buildRegistryLink('linuxserver/sonarr:latest'), {
    url: 'https://hub.docker.com/r/linuxserver/sonarr/tags',
    label: 'Docker Hub',
  });
  assert.deepEqual(buildRegistryLink('ghcr.io/foo/bar:1.0'), {
    url: 'https://github.com/foo/bar',
    label: 'GitHub',
  });
});
