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

import { registryBaseUrl } from '../src/registry.js';

test('registryBaseUrl: loopback registries use http (like Docker), everything else https', () => {
  assert.equal(registryBaseUrl('localhost:5000'), 'http://localhost:5000');
  assert.equal(registryBaseUrl('127.0.0.1:5005'), 'http://127.0.0.1:5005');
  assert.equal(registryBaseUrl('[::1]:5000'), 'http://[::1]:5000');
  assert.equal(registryBaseUrl('docker.io'), 'https://registry-1.docker.io');
  assert.equal(registryBaseUrl('ghcr.io'), 'https://ghcr.io');
  assert.equal(registryBaseUrl('registry.local:5000'), 'https://registry.local:5000');
  assert.equal(registryBaseUrl('localhost.evil.com'), 'https://localhost.evil.com');
});

import { nextPageUrl } from '../src/registry.js';

test('nextPageUrl: follows same-origin rel=next links only', () => {
  const base = 'https://registry-1.docker.io';
  assert.equal(
    nextPageUrl('</v2/library/postgres/tags/list?last=16.3&n=1000>; rel="next"', base),
    'https://registry-1.docker.io/v2/library/postgres/tags/list?last=16.3&n=1000'
  );
  assert.equal(nextPageUrl('<https://evil.example/v2/x/tags/list>; rel="next"', base), null);
  assert.equal(nextPageUrl(null, base), null);
  assert.equal(nextPageUrl('</v2/x>; rel="prev"', base), null);
});
