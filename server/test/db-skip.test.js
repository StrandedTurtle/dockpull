import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point DATA_DIR at a throwaway dir BEFORE importing db.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dockpull-skip-'));
process.env.DATA_DIR = tmp;

const db = await import('../src/db.js');
const { buildContainerItems } = await import('../src/containers-service.js');

const REF = 'docker.io/library/nginx:latest';
const container = {
  name: 'nginx',
  image: 'nginx:latest',
  currentDigest: 'sha256:aaa',
  normalizedRef: REF,
  state: 'running',
};
const items = () =>
  buildContainerItems({
    containers: [container],
    lookupEvent: db.latestUnresolvedEventForRef,
    isPinned: () => false,
  }).items;

test('skip hides the offered build; a newer build shows up again; unskip restores', () => {
  db.recordEvent({ image: 'nginx:latest', normalized_ref: REF, status: 'update', digest: 'sha256:bbb', available_version: '1.1' });
  assert.equal(items()[0].updateAvailable, true);

  assert.equal(db.setLatestEventSkipped(REF, true), true);
  let [it] = items();
  assert.equal(it.updateAvailable, false);
  assert.equal(it.skipped, true);
  assert.equal(it.availableVersion, '1.1');

  assert.equal(db.setLatestEventSkipped(REF, false), true);
  assert.equal(items()[0].updateAvailable, true);

  db.setLatestEventSkipped(REF, true);
  db.recordEvent({ image: 'nginx:latest', normalized_ref: REF, status: 'update', digest: 'sha256:ccc' });
  [it] = items();
  assert.equal(it.updateAvailable, true);
  assert.equal(it.skipped, false);
  assert.equal(it.availableDigest, 'sha256:ccc');
});

test('skip with no pending update reports nothing changed', () => {
  assert.equal(db.setLatestEventSkipped('docker.io/library/none:latest', true), false);
});
