import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWwwAuthenticate } from '../src/registry.js';

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
