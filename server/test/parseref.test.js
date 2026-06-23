import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRef } from '../src/reconcile.js';

test('parseRef: official short name gets library namespace and latest tag', () => {
  assert.deepEqual(parseRef('nginx'), {
    registry: 'docker.io',
    repository: 'library/nginx',
    tag: 'latest',
    digest: null,
  });
});

test('parseRef: explicit tag preserved', () => {
  assert.deepEqual(parseRef('nginx:1.25'), {
    registry: 'docker.io',
    repository: 'library/nginx',
    tag: '1.25',
    digest: null,
  });
});

test('parseRef: third-party registry, repo lowercased, tag case preserved', () => {
  assert.deepEqual(parseRef('ghcr.io/Foo/Bar:Tag'), {
    registry: 'ghcr.io',
    repository: 'foo/bar',
    tag: 'Tag',
    digest: null,
  });
});

test('parseRef: registry with port is not mistaken for a tag', () => {
  assert.deepEqual(parseRef('registry:5000/team/app:v1'), {
    registry: 'registry:5000',
    repository: 'team/app',
    tag: 'v1',
    digest: null,
  });
});

test('parseRef: two-segment Docker Hub image keeps its namespace', () => {
  assert.deepEqual(parseRef('lscr.io/linuxserver/sonarr'), {
    registry: 'lscr.io',
    repository: 'linuxserver/sonarr',
    tag: 'latest',
    digest: null,
  });
});

test('parseRef: digest-pinned ref has no tag and captures the digest', () => {
  assert.deepEqual(parseRef('nginx@sha256:abc123'), {
    registry: 'docker.io',
    repository: 'library/nginx',
    tag: null,
    digest: 'sha256:abc123',
  });
});
