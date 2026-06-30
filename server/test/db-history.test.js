import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point DATA_DIR at a throwaway dir BEFORE importing db — it creates the SQLite
// file from config.DATA_DIR at import time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dockpull-db-'));
process.env.DATA_DIR = tmp;

const db = await import('../src/db.js');

test('clearHistory: removes all update-history rows', () => {
  db.recordUpdate({
    container_name: 'nginx',
    image: 'nginx:latest',
    old_digest: 'sha256:a',
    new_digest: 'sha256:b',
    status: 'success',
  });
  db.recordUpdate({
    container_name: 'redis',
    image: 'redis:7',
    old_digest: 'sha256:c',
    new_digest: 'sha256:d',
    status: 'success',
  });
  assert.equal(db.getHistory({}).length, 2);

  db.clearHistory();
  assert.equal(db.getHistory({}).length, 0);

  // Idempotent on an already-empty table.
  assert.doesNotThrow(() => db.clearHistory());
  assert.equal(db.getHistory({}).length, 0);
});
