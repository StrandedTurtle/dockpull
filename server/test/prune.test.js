import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// A fake Docker Engine API on a unix socket, so the prune code runs for real
// (dockerode, query params, measured disk usage) without a daemon.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dockpull-prune-'));
const socketPath = path.join(tmp, 'docker.sock');
process.env.DOCKER_SOCKET = socketPath;
process.env.DATA_DIR = tmp;

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const ID = (c) => `sha256:${c.repeat(64)}`;
// Two old images of an app: each is 1 GB in total, but 900 MB of that is the
// base layer the CURRENT (tagged, in-use) image still uses. Only ~100 MB each
// is actually freed by deleting them.
let dangling = [
  { Id: ID('a'), Size: 1000 * MB, SharedSize: 900 * MB, Created: 1 },
  { Id: ID('b'), Size: 1000 * MB, SharedSize: 900 * MB, Created: 2 },
];
let layersSize = 5 * GB;
let inUse = []; // image IDs containers run
const requests = [];

const server = http.createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  const url = new URL(req.url, 'http://docker');
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && url.pathname.endsWith('/images/json')) {
    // Like Docker: SharedSize is only meaningful when computed across ALL
    // images. With the dangling filter, a lone leftover looks fully unique.
    if (url.searchParams.get('filters')) {
      return json(200, dangling.map((i) => ({ ...i, SharedSize: dangling.length > 1 ? i.SharedSize : 0 })));
    }
    return json(200, [...dangling, { Id: ID('c'), Size: 1000 * MB, SharedSize: 900 * MB, RepoTags: ['app:latest'] }]);
  }
  if (req.method === 'GET' && url.pathname.endsWith('/containers/json')) {
    return json(200, inUse.map((ImageID) => ({ Id: 'c1', ImageID })));
  }
  if (req.method === 'GET' && url.pathname.endsWith('/system/df')) return json(200, { LayersSize: layersSize });
  const del = url.pathname.match(/\/images\/(sha256:[0-9a-f]+)$/);
  if (req.method === 'DELETE' && del) {
    dangling = dangling.filter((i) => i.Id !== del[1]);
    layersSize -= 100 * MB; // what the daemon really frees
    return json(200, [{ Deleted: del[1] }]);
  }
  json(404, { message: 'not found' });
});
await new Promise((r) => server.listen(socketPath, r));

const docker = await import('../src/docker.js');
test.after(() => server.close());

test('reclaimableSize: whole size minus the part shared with other images', () => {
  assert.deepEqual(docker.reclaimableSize({ Size: 1000, SharedSize: 900 }), { size: 100, exact: true });
  assert.deepEqual(docker.reclaimableSize({ Size: 1000, SharedSize: -1 }), { size: 1000, exact: false });
  assert.deepEqual(docker.reclaimableSize({ Size: 1000 }), { size: 1000, exact: false });
});

test('listDanglingImages: preview reports reclaimable bytes, not whole-image sizes', async () => {
  const r = await docker.listDanglingImages();
  assert.equal(r.count, 2);
  assert.equal(r.totalSize, 200 * MB); // was 2 GB before the fix
  assert.equal(r.exact, true);
  assert.equal(r.images[0].fullSize, 1000 * MB);
  assert.ok(requests.some((q) => q.includes('/images/json') && q.includes('shared-size=true')));
});

test('listDanglingImages: a lone leftover still counts the base layer it shares with the current image', async () => {
  const saved = dangling;
  dangling = [saved[0]];
  try {
    const r = await docker.listDanglingImages();
    assert.equal(r.totalSize, 100 * MB);
  } finally {
    dangling = saved;
  }
});

test('listDanglingImages: untagged images a container still uses are not offered', async () => {
  inUse = [ID('b')];
  try {
    const r = await docker.listDanglingImages();
    assert.deepEqual(r.images.map((i) => i.id), ['aaaaaaaaaaaa']);
  } finally {
    inUse = [];
  }
});

test('removeDanglingImages: reports MEASURED space freed and only removes requested dangling images', async () => {
  requests.length = 0;
  const r = await docker.removeDanglingImages(['aaaaaaaaaaaa', 'ffffffffffff' /* not dangling */]);
  assert.equal(r.deleted, 1);
  assert.deepEqual(r.removedIds, ['aaaaaaaaaaaa']);
  assert.equal(r.spaceReclaimed, 100 * MB); // was 1 GB before the fix
  assert.ok(requests.some((q) => q.startsWith('GET') && q.includes('/system/df') && q.includes('type=image')));
  assert.equal(requests.filter((q) => q.startsWith('DELETE')).length, 1);
  assert.equal(dangling.length, 1);
});

test('pruneDanglingImages: counts images (not untag/layer entries) and measures space', async () => {
  const r = await docker.pruneDanglingImages();
  assert.equal(r.deleted, 1);
  assert.equal(r.spaceReclaimed, 100 * MB);
  assert.equal(dangling.length, 0);
});
