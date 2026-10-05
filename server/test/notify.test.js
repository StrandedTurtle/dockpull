import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiscordPayload,
  buildNtfyMessage,
  buildGotifyPayload,
  buildWebhookPayload,
  buildNtfyUrl,
  sendUpdates,
  sendTest,
} from '../src/notify.js';
import http from 'node:http';

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

test('versions: shows "current → available", and flags same-version rebuilds', () => {
  const p = buildDiscordPayload([
    { name: 'a', image: 'a:latest', currentVersion: '1.0.0', availableVersion: '1.1.0' },
    { name: 'b', image: 'b:latest', currentVersion: '2.0.0', availableVersion: '2.0.0' },
  ]);
  assert.match(p.content, /1\.0\.0 → 1\.1\.0/);
  assert.match(p.content, /2\.0\.0, rebuilt/);
});

test('buildNtfyUrl: carries title/tags as query params and keeps existing ones', () => {
  const u = new URL(buildNtfyUrl('https://ntfy.example/topic?auth=abc', { title: '🔔 2 updates', tags: 'package' }));
  assert.equal(u.searchParams.get('auth'), 'abc');
  assert.equal(u.searchParams.get('title'), '🔔 2 updates');
  assert.equal(u.searchParams.get('tags'), 'package');
});

// Regression: the emoji title used to go in a `Title` header, which fetch
// rejects (headers must be Latin-1) — so every real ntfy notification threw.
test('sendUpdates/sendTest (ntfy): emoji titles are delivered, not thrown', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, body });
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/updates`;
  try {
    const r1 = await sendUpdates('ntfy', url, items);
    const r2 = await sendTest('ntfy', url);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    const q = new URL(received[0].url, 'http://x').searchParams;
    assert.match(q.get('title'), /🔔 2 container updates available/);
    assert.match(received[0].body, /jellyfin/);
  } finally {
    server.close();
  }
});

import { buildFailureMessage, sendFailure } from '../src/notify.js';

test('buildFailureMessage: names the container and trims long output', () => {
  const m = buildFailureMessage({ name: 'db', image: 'postgres:16', message: Array(20).fill('line').join('\n') });
  assert.match(m.title, /Update of db failed/);
  assert.equal(m.body.split('\n').length, 7); // image + 6 lines
  assert.match(buildFailureMessage({ name: 'x', action: 'revert' }).title, /Revert of x failed/);
});

test('sendFailure: every target type delivers (ntfy emoji title via query)', async () => {
  const got = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      got.push({ url: req.url, body: b });
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/x`;
  try {
    for (const type of ['discord', 'ntfy', 'gotify', 'webhook']) {
      const r = await sendFailure(type, url, { name: 'db', image: 'postgres:16', message: 'boom' });
      assert.equal(r.ok, true, type);
    }
    assert.match(new URL(got[1].url, 'http://x').searchParams.get('title'), /Update of db failed/);
    assert.match(got[0].body, /boom/);
  } finally {
    server.close();
  }
});
