import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// End-to-end-ish checker tests: the real runCheck() + listContainers() run
// against a fake Docker Engine API (unix socket) and a fake registry on
// 127.0.0.1 (loopback registries are spoken to over http, like Docker does).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dockpull-checker-'));
process.env.DOCKER_SOCKET = path.join(tmp, 'docker.sock');
process.env.DATA_DIR = tmp;

const D = (c) => `sha256:${c.repeat(64)}`;

// --- fake registry ------------------------------------------------------
const registry = { digests: {}, tags: {}, hits: [] }; // digests["app:1.0.0"] = digest
const regServer = http.createServer((req, res) => {
  registry.hits.push(`${req.method} ${req.url}`);
  const m = /^\/v2\/(.+)\/(manifests|tags)\/(.+?)(\?.*)?$/.exec(req.url);
  if (!m) return res.writeHead(404).end();
  const [, repo, kind, rest] = m;
  if (kind === 'manifests') {
    const digest = registry.digests[`${repo}:${decodeURIComponent(rest)}`];
    if (!digest) return res.writeHead(404).end();
    res.writeHead(200, { 'Docker-Content-Digest': digest, 'Content-Type': 'application/json' });
    return res.end(req.method === 'HEAD' ? undefined : '{}');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ name: repo, tags: registry.tags[repo] || [] }));
});
await new Promise((r) => regServer.listen(0, '127.0.0.1', r));
const REG = `127.0.0.1:${regServer.address().port}`;

// --- fake docker ----------------------------------------------------------
// containers: { name: { image (ref), imageId } }; images: { id/ref: { RepoDigests, Labels } }
const docker = { containers: {}, images: {} };
const dockerServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://d');
  const p = url.pathname.replace(/^\/v[\d.]+/, '');
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (p === '/containers/json') {
    return json(200, Object.keys(docker.containers).map((n) => ({ Id: `id-${n}`, State: 'running' })));
  }
  let m = /^\/containers\/(?:id-)?([^/]+)\/json$/.exec(p);
  if (m && docker.containers[m[1]]) {
    const c = docker.containers[m[1]];
    return json(200, {
      Id: `id-${m[1]}`,
      Name: `/${m[1]}`,
      Image: c.imageId,
      Config: { Image: c.image, Labels: c.labels || {} },
      State: { Status: 'running', Running: true },
    });
  }
  m = /^\/images\/(.+)\/json$/.exec(p);
  if (m) {
    const img = docker.images[decodeURIComponent(m[1])];
    if (!img) return json(404, { message: 'no such image' });
    return json(200, { Id: img.Id, RepoDigests: img.RepoDigests || [], Config: { Labels: img.Labels || {} } });
  }
  return json(404, { message: `unhandled ${p}` });
});
await new Promise((r) => dockerServer.listen(process.env.DOCKER_SOCKET, r));

const { runCheck } = await import('../src/checker.js');
const db = await import('../src/db.js');
const { updateSettings } = await import('../src/settings.js');

test.after(() => {
  regServer.close();
  dockerServer.close();
});

function reset() {
  docker.containers = {};
  docker.images = {};
  registry.digests = {};
  registry.tags = {};
  registry.hits = [];
  db.db.exec('DELETE FROM update_events; DELETE FROM tag_updates;');
}

function addImage(id, { repoDigests = [], labels = {}, tagRef = null } = {}) {
  docker.images[id] = { Id: id, RepoDigests: repoDigests, Labels: labels };
  if (tagRef) docker.images[tagRef] = docker.images[id];
}

test('up to date when the registry digest is ANY of the image\'s repo digests (re-pushed index)', async () => {
  reset();
  const ref = `${REG}/app:latest`;
  addImage(D('1'), { repoDigests: [`${REG}/app@${D('a')}`, `${REG}/app@${D('b')}`], tagRef: ref });
  docker.containers.web = { image: ref, imageId: D('1') };
  registry.digests['app:latest'] = D('b'); // the second, lexically later digest
  const r = await runCheck();
  assert.equal(r.updatesFound, 0);
  assert.equal(r.errors, 0);
  assert.equal(db.latestUnresolvedEventForRef(`${REG}/app:latest`), undefined);
});

test('a genuinely new digest is recorded as an update, once', async () => {
  reset();
  const ref = `${REG}/app:latest`;
  addImage(D('1'), { repoDigests: [`${REG}/app@${D('a')}`], tagRef: ref });
  docker.containers.web = { image: ref, imageId: D('1') };
  registry.digests['app:latest'] = D('c');
  assert.equal((await runCheck()).updatesFound, 1);
  assert.equal(db.latestUnresolvedEventForRef(`${REG}/app:latest`).digest, D('c'));
  assert.equal((await runCheck()).updatesFound, 0, 'not re-recorded on the next check');
});

test('a container left on an untagged image (sibling updated first) is still flagged', async () => {
  reset();
  const ref = `${REG}/app:latest`;
  // The tag now points at the new image; "old" lost its tag and RepoDigests
  // (containerd image store), but container "b" still runs it.
  addImage(D('2'), { repoDigests: [`${REG}/app@${D('n')}`], tagRef: ref });
  addImage(D('1'), { repoDigests: [] });
  docker.containers.a = { image: ref, imageId: D('2') };
  docker.containers.b = { image: ref, imageId: D('1') };
  registry.digests['app:latest'] = D('n');
  const r = await runCheck();
  assert.equal(r.updatesFound, 1);
});

test('a locally built image (no registry digest) is skipped without a registry call', async () => {
  reset();
  addImage(D('3'), { repoDigests: [], tagRef: 'mylocal:dev' });
  docker.containers.local = { image: 'mylocal:dev', imageId: D('3') };
  const r = await runCheck();
  assert.deepEqual([r.total, r.checked, r.updatesFound, r.errors], [1, 1, 0, 0]);
  assert.equal(registry.hits.length, 0);
});

test('newer version tags are found for version-tagged containers', async () => {
  reset();
  updateSettings({ tagUpdates: 'major' });
  const ref = `${REG}/app:1.0.0`;
  addImage(D('4'), { repoDigests: [`${REG}/app@${D('d')}`], tagRef: ref });
  docker.containers.svc = { image: ref, imageId: D('4') };
  registry.digests['app:1.0.0'] = D('d');
  registry.tags.app = ['1.0.0', '1.0.1', '1.1.0', '1.2.0-rc1', '2.0.0', 'latest'];
  await runCheck();
  const row = db.getTagUpdate(`${REG}/app:1.0.0`);
  assert.equal(row.same_major, '1.1.0');
  assert.equal(row.next_major, '2.0.0');
});

test('concurrent checks share one run (no duplicate registry calls or events)', async () => {
  reset();
  const ref = `${REG}/app:latest`;
  addImage(D('1'), { repoDigests: [`${REG}/app@${D('a')}`], tagRef: ref });
  docker.containers.web = { image: ref, imageId: D('1') };
  registry.digests['app:latest'] = D('e');
  const [r1, r2] = await Promise.all([runCheck(), runCheck()]);
  assert.equal(r1, r2);
  assert.equal(registry.hits.filter((h) => h.startsWith('HEAD')).length, 1);
  const n = db.db.prepare('SELECT COUNT(*) AS n FROM update_events WHERE resolved = 0').get().n;
  assert.equal(n, 1);
});
