import { test } from 'node:test';
import assert from 'node:assert/strict';
import { knownSourceFor } from '../src/known-sources.js';

test('knownSourceFor: table entries, any spelling of the ref', () => {
  assert.equal(knownSourceFor('redis:7'), 'https://github.com/redis/redis');
  assert.equal(knownSourceFor('docker.io/library/redis:7-alpine'), 'https://github.com/redis/redis');
  assert.equal(knownSourceFor('vaultwarden/server:latest'), 'https://github.com/dani-garcia/vaultwarden');
  assert.equal(knownSourceFor('ghcr.io/immich-app/immich-server:release'), 'https://github.com/immich-app/immich');
});

test('knownSourceFor: linuxserver images on every registry', () => {
  for (const img of ['lscr.io/linuxserver/sonarr:latest', 'linuxserver/sonarr', 'ghcr.io/linuxserver/sonarr:4']) {
    assert.equal(knownSourceFor(img), 'https://github.com/linuxserver/docker-sonarr', img);
  }
});

test('knownSourceFor: unknown images get nothing', () => {
  assert.equal(knownSourceFor('postgres:16'), null);
  assert.equal(knownSourceFor('ghcr.io/someone/thing:1'), null);
  assert.equal(knownSourceFor('lscr.io/other/sonarr'), null);
});
