import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as jobs from '../src/jobs.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake job that records when it ran, so ordering/overlap can be asserted.
function recorder() {
  const events = [];
  let active = 0;
  let maxActive = 0;
  const make = (name, ms = 20, success = true) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    events.push(`start ${name}`);
    await sleep(ms);
    events.push(`end ${name}`);
    active -= 1;
    return { success, message: success ? 'ok' : 'boom' };
  };
  return { events, make, get maxActive() { return maxActive; } };
}

beforeEach(async () => {
  await jobs._drain();
  jobs._reset();
});

test('same stack runs one at a time, in order', async () => {
  const r = recorder();
  jobs.enqueue({ name: 'a', kind: 'update', project: 'web', execute: r.make('a') });
  jobs.enqueue({ name: 'b', kind: 'update', project: 'web', execute: r.make('b') });
  await jobs._drain();
  assert.deepEqual(r.events, ['start a', 'end a', 'start b', 'end b']);
});

test('different stacks run in parallel, capped at 3', async () => {
  const r = recorder();
  for (const n of ['a', 'b', 'c', 'd', 'e']) jobs.enqueue({ name: n, kind: 'update', project: n, execute: r.make(n, 30) });
  await jobs._drain();
  assert.equal(r.maxActive, 3);
  assert.equal(r.events.filter((e) => e.startsWith('end')).length, 5);
});

test('one job per container; a second is refused while busy', async () => {
  const r = recorder();
  jobs.enqueue({ name: 'a', kind: 'update', execute: r.make('a') });
  assert.equal(jobs.isBusy('a'), true);
  assert.throws(() => jobs.enqueue({ name: 'a', kind: 'revert', execute: r.make('a2') }), { code: 'busy' });
  await jobs._drain();
  assert.equal(jobs.isBusy('a'), false);
  jobs.enqueue({ name: 'a', kind: 'revert', execute: r.make('a3') }); // fine once done
  await jobs._drain();
});

test('a throwing job is recorded as failed and does not block its lane', async () => {
  const r = recorder();
  jobs.enqueue({ name: 'x', kind: 'update', project: 'p', execute: async () => { throw new Error('kaboom'); } });
  jobs.enqueue({ name: 'y', kind: 'update', project: 'p', execute: r.make('y') });
  await jobs._drain();
  const snap = jobs.snapshot();
  const x = snap.jobs.find((j) => j.name === 'x');
  assert.equal(x.success, false);
  assert.equal(x.message, 'kaboom');
  assert.equal(snap.jobs.find((j) => j.name === 'y').success, true);
});

test('batch: summary reported once, when the last job finishes', async () => {
  const r = recorder();
  const done = [];
  jobs.onBatchDone((s) => done.push(s));
  const id = jobs.startBatch();
  jobs.enqueue({ name: 'a', kind: 'update', project: 's1', batchId: id, execute: r.make('a') });
  jobs.enqueue({ name: 'b', kind: 'update', project: 's1', batchId: id, execute: r.make('b', 20, false) });
  jobs.enqueue({ name: 'c', kind: 'update', project: 's2', batchId: id, execute: r.make('c') });
  jobs.sealBatch(id);
  assert.equal(jobs.snapshot().batch.total, 3);
  await jobs._drain();
  assert.equal(done.length, 1);
  assert.deepEqual(done[0].succeeded.sort(), ['a', 'c']);
  assert.deepEqual(done[0].failed.map((f) => f.name), ['b']);
  assert.ok(jobs.snapshot().batch.finishedAt);
});

test('snapshot keeps finished jobs for a while, then forgets them', async () => {
  const r = recorder();
  jobs.enqueue({ name: 'a', kind: 'update', execute: r.make('a') });
  await jobs._drain();
  assert.equal(jobs.snapshot().jobs.length, 1);
  assert.equal(jobs.snapshot(Date.now() + 16 * 60_000).jobs.length, 0);
});
