import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscordPayload } from '../src/notify.js';

test('buildDiscordPayload: header pluralizes and lists items', () => {
  const p = buildDiscordPayload([
    { name: 'jellyfin', image: 'jellyfin/jellyfin:latest', currentVersion: '10.9.0' },
    { name: 'radarr', image: 'lscr.io/linuxserver/radarr:latest', currentVersion: null },
  ]);
  assert.match(p.content, /2 container updates available/);
  assert.match(p.content, /jellyfin/);
  assert.match(p.content, /current: 10\.9\.0/);
  assert.match(p.content, /radarr/);
});

test('buildDiscordPayload: singular for one item', () => {
  const p = buildDiscordPayload([{ name: 'nginx', image: 'nginx:latest' }]);
  assert.match(p.content, /1 container update available/);
});
