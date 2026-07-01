import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiscordPayload,
  buildNtfyMessage,
  buildGotifyPayload,
  buildWebhookPayload,
} from '../src/notify.js';

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

const items = [
  { name: 'jellyfin', image: 'jellyfin/jellyfin:latest', currentVersion: '10.9.0' },
  { name: 'radarr', image: 'lscr.io/linuxserver/radarr:latest' },
];

test('buildNtfyMessage: title + plain-text body + tags', () => {
  const m = buildNtfyMessage(items);
  assert.match(m.title, /2 container updates available/);
  assert.match(m.body, /jellyfin/);
  assert.match(m.body, /radarr/);
  assert.equal(typeof m.tags, 'string');
});

test('buildGotifyPayload: title/message/priority', () => {
  const p = buildGotifyPayload(items);
  assert.match(p.title, /2 container updates available/);
  assert.match(p.message, /jellyfin/);
  assert.equal(typeof p.priority, 'number');
});

test('buildWebhookPayload: structured containers array', () => {
  const p = buildWebhookPayload(items);
  assert.equal(p.count, 2);
  assert.equal(p.containers.length, 2);
  assert.equal(p.containers[0].name, 'jellyfin');
  assert.equal(p.containers[0].currentVersion, '10.9.0');
  assert.equal(p.containers[1].currentVersion, null);
});
