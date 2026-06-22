import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRef, isUpdateAvailable, digestsEqual } from '../src/reconcile.js';

describe('normalizeRef', () => {
  test('bare official image name gets docker.io/library + latest tag', () => {
    assert.equal(normalizeRef('nginx'), 'docker.io/library/nginx:latest');
  });

  test('bare official image with explicit tag', () => {
    assert.equal(normalizeRef('nginx:1.25'), 'docker.io/library/nginx:1.25');
  });

  test('library/ prefix with explicit latest tag', () => {
    assert.equal(normalizeRef('library/nginx:latest'), 'docker.io/library/nginx:latest');
  });

  test('fully qualified docker.io/library ref is a no-op', () => {
    assert.equal(normalizeRef('docker.io/library/nginx:latest'), 'docker.io/library/nginx:latest');
  });

  test('third-party registry with explicit tag is preserved', () => {
    assert.equal(normalizeRef('ghcr.io/foo/bar:tag'), 'ghcr.io/foo/bar:tag');
  });

  test('third-party registry without tag defaults to latest', () => {
    assert.equal(normalizeRef('lscr.io/linuxserver/sonarr'), 'lscr.io/linuxserver/sonarr:latest');
  });

  test('registry with explicit port is not mistaken for a tag', () => {
    assert.equal(normalizeRef('registry:5000/team/app:v1'), 'registry:5000/team/app:v1');
  });

  test('registry with explicit port and no tag defaults to latest', () => {
    assert.equal(normalizeRef('registry:5000/team/app'), 'registry:5000/team/app:latest');
  });

  test('digest-pinned official image strips digest and has no tag', () => {
    assert.equal(
      normalizeRef('nginx@sha256:abcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabc'),
      'docker.io/library/nginx'
    );
  });

  test('digest-pinned ref with third-party registry strips digest, no tag', () => {
    assert.equal(
      normalizeRef('ghcr.io/foo/bar@sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
      'ghcr.io/foo/bar'
    );
  });

  test('two-segment Docker Hub image (no registry-looking first segment)', () => {
    assert.equal(normalizeRef('linuxserver/sonarr'), 'docker.io/linuxserver/sonarr:latest');
  });

  test('two-segment Docker Hub image with explicit tag', () => {
    assert.equal(normalizeRef('linuxserver/sonarr:latest'), 'docker.io/linuxserver/sonarr:latest');
  });

  test('localhost registry without port is recognized as a registry host', () => {
    assert.equal(normalizeRef('localhost/myimage:dev'), 'localhost/myimage:dev');
  });

  test('localhost registry with port', () => {
    assert.equal(normalizeRef('localhost:5000/myimage'), 'localhost:5000/myimage:latest');
  });

  test('deep path under a third-party registry', () => {
    assert.equal(
      normalizeRef('ghcr.io/org/team/project:v2.0.0'),
      'ghcr.io/org/team/project:v2.0.0'
    );
  });

  test('registry and repo path are lowercased, tag case preserved', () => {
    assert.equal(normalizeRef('GHCR.IO/Foo/Bar:MyTag'), 'ghcr.io/foo/bar:MyTag');
  });

  test('bare official image name with mixed case is lowercased', () => {
    assert.equal(normalizeRef('NGINX'), 'docker.io/library/nginx:latest');
  });

  test('leading/trailing whitespace is trimmed', () => {
    assert.equal(normalizeRef('  nginx:1.25  '), 'docker.io/library/nginx:1.25');
  });

  test('throws on non-string input', () => {
    assert.throws(() => normalizeRef(null), TypeError);
    assert.throws(() => normalizeRef(undefined), TypeError);
    assert.throws(() => normalizeRef(42), TypeError);
  });

  test('throws on empty string', () => {
    assert.throws(() => normalizeRef(''), TypeError);
    assert.throws(() => normalizeRef('   '), TypeError);
  });
});

describe('isUpdateAvailable', () => {
  test('returns false when digests are equal', () => {
    assert.equal(isUpdateAvailable('sha256:abc123', 'sha256:abc123'), false);
  });

  test('returns true when digests differ', () => {
    assert.equal(isUpdateAvailable('sha256:abc123', 'sha256:def456'), true);
  });

  test('returns false when currentDigest is missing', () => {
    assert.equal(isUpdateAvailable(null, 'sha256:def456'), false);
    assert.equal(isUpdateAvailable(undefined, 'sha256:def456'), false);
    assert.equal(isUpdateAvailable('', 'sha256:def456'), false);
  });

  test('returns false when eventDigest is missing', () => {
    assert.equal(isUpdateAvailable('sha256:abc123', null), false);
    assert.equal(isUpdateAvailable('sha256:abc123', undefined), false);
    assert.equal(isUpdateAvailable('sha256:abc123', ''), false);
  });

  test('returns false when both digests are missing', () => {
    assert.equal(isUpdateAvailable(null, null), false);
    assert.equal(isUpdateAvailable('', ''), false);
  });

  test('returns false for malformed (non sha256:) digest strings', () => {
    assert.equal(isUpdateAvailable('not-a-digest', 'sha256:def456'), false);
    assert.equal(isUpdateAvailable('sha256:abc123', 'also-not-a-digest'), false);
  });

  test('is case-insensitive on the sha256 prefix and hex digits', () => {
    assert.equal(isUpdateAvailable('SHA256:ABC123', 'sha256:abc123'), false);
    assert.equal(isUpdateAvailable('SHA256:ABC123', 'sha256:def456'), true);
  });
});

describe('digestsEqual', () => {
  test('returns true for identical digests', () => {
    assert.equal(digestsEqual('sha256:abc123', 'sha256:abc123'), true);
  });

  test('returns false for differing digests', () => {
    assert.equal(digestsEqual('sha256:abc123', 'sha256:def456'), false);
  });

  test('tolerates surrounding whitespace', () => {
    assert.equal(digestsEqual('  sha256:abc123 \n', 'sha256:abc123'), true);
  });

  test('tolerates case differences', () => {
    assert.equal(digestsEqual('SHA256:ABC123', 'sha256:abc123'), true);
  });

  test('returns false when either side is missing/empty', () => {
    assert.equal(digestsEqual(null, 'sha256:abc123'), false);
    assert.equal(digestsEqual('sha256:abc123', undefined), false);
    assert.equal(digestsEqual('', ''), false);
  });

  test('returns false for malformed digest strings', () => {
    assert.equal(digestsEqual('abc123', 'abc123'), false);
  });
});
