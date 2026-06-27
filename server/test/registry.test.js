import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWwwAuthenticate, pickPlatformManifest } from '../src/registry.js';

test('parseWwwAuthenticate: parses realm/service/scope from a Bearer challenge', () => {
  const header =
    'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"';
  assert.deepEqual(parseWwwAuthenticate(header), {
    realm: 'https://auth.docker.io/token',
    service: 'registry.docker.io',
    scope: 'repository:library/nginx:pull',
  });
});

test('parseWwwAuthenticate: returns null for non-Bearer or empty headers', () => {
  assert.equal(parseWwwAuthenticate(null), null);
  assert.equal(parseWwwAuthenticate(''), null);
  assert.equal(parseWwwAuthenticate('Basic realm="x"'), null);
});

test('pickPlatformManifest: prefers linux/amd64', () => {
  const manifests = [
    { digest: 'sha256:arm', platform: { os: 'linux', architecture: 'arm64' } },
    { digest: 'sha256:amd', platform: { os: 'linux', architecture: 'amd64' } },
  ];
  assert.equal(pickPlatformManifest(manifests).digest, 'sha256:amd');
});

test('pickPlatformManifest: falls back to any linux platform', () => {
  const manifests = [
    { digest: 'sha256:windows', platform: { os: 'windows', architecture: 'amd64' } },
    { digest: 'sha256:arm', platform: { os: 'linux', architecture: 'arm64' } },
  ];
  assert.equal(pickPlatformManifest(manifests).digest, 'sha256:arm');
});

test('pickPlatformManifest: falls back to the first entry when nothing matches', () => {
  const manifests = [{ digest: 'sha256:first', platform: { os: 'windows', architecture: 'amd64' } }];
  assert.equal(pickPlatformManifest(manifests).digest, 'sha256:first');
});

test('pickPlatformManifest: returns null for empty/non-array input', () => {
  assert.equal(pickPlatformManifest([]), null);
  assert.equal(pickPlatformManifest(null), null);
  assert.equal(pickPlatformManifest(undefined), null);
});
