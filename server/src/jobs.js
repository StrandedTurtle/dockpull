/**
 * Server-side job queue for updates, reverts and tag switches.
 *
 * Updates used to be driven by the browser: "Update all" was a loop in the
 * dashboard page, so navigating away, locking the phone or a card scrolling
 * out of view stopped the batch part-way, and coming back showed nothing of
 * what was still running. Now every job runs here, independent of any page:
 *
 *  - Jobs in the same stack (compose project) run one at a time — concurrent
 *    `docker compose up` calls against one project race on its networks and
 *    dependencies — while different stacks run in parallel, at most
 *    MAX_PARALLEL at once (to not saturate the host's bandwidth/disk).
 *  - Each container has at most one queued/running job (a second is refused).
 *  - Finished jobs are remembered for RETAIN_MS so a dashboard that comes back
 *    can show what happened (and replay the log — see sse.js).
 *  - A batch ("Update all") is tracked as a whole, and `onBatchDone` fires once
 *    when its last job finishes (used for the summary notification).
 *
 * The work itself is injected (`execute`), so this module is pure scheduling
 * and fully unit-testable. Jobs live in memory: a server restart forgets them.
 */

const MAX_PARALLEL = 3;
const RETAIN_MS = 15 * 60_000;

const jobs = new Map(); // container name -> latest job
const lanes = new Map(); // lane key -> tail promise of that lane
const batches = new Map(); // batch id -> batch
let running = 0;
const waiting = []; // resolvers waiting for a parallel slot
let seq = 0;
const listeners = { change: [], batchDone: [] };

function emit(kind, payload) {
  for (const fn of listeners[kind]) {
    try {
      fn(payload);
    } catch (err) {
      console.warn(`jobs.js: ${kind} listener threw: ${err.message}`);
    }
  }
}

/** Subscribe to queue changes (enqueue / start / finish). */
export function onChange(fn) {
  listeners.change.push(fn);
}

/** Subscribe to "a batch finished" (receives the batch summary). */
export function onBatchDone(fn) {
  listeners.batchDone.push(fn);
}

async function acquireSlot() {
  if (running < MAX_PARALLEL) {
    running += 1;
    return;
  }
  await new Promise((resolve) => waiting.push(resolve));
  running += 1;
}

function releaseSlot() {
  running -= 1;
  const next = waiting.shift();
  if (next) next();
}

/** True if `name` has a queued or running job. */
export function isBusy(name) {
  const j = jobs.get(name);
  return Boolean(j && (j.status === 'queued' || j.status === 'running'));
}

function publicJob(j) {
  const { execute, ...rest } = j;
  return rest;
}

/**
 * Queue a job.
 *
 * @param {object} spec
 * @param {string} spec.name - container name.
 * @param {string} spec.kind - 'update' | 'revert' | 'switch'.
 * @param {string|null} [spec.project] - compose project (lane); null = own lane.
 * @param {string|null} [spec.batchId]
 * @param {object} [spec.meta] - extra fields shown to clients (e.g. tag).
 * @param {(job) => Promise<{ success: boolean, message: string }>} spec.execute
 * @returns {object} the job (public fields).
 * @throws {Error} with `.code = 'busy'` if the container already has a job.
 */
export function enqueue({ name, kind, project = null, batchId = null, meta = {}, execute }) {
  if (isBusy(name)) {
    const err = new Error(`${name} already has an update queued or running`);
    err.code = 'busy';
    throw err;
  }
  const job = {
    id: ++seq,
    name,
    kind,
    project,
    batchId,
    ...meta,
    status: 'queued',
    queuedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    success: null,
    message: null,
    execute,
  };
  jobs.set(name, job);
  if (batchId && batches.has(batchId)) batches.get(batchId).names.push(name);

  const laneKey = project ? `p:${project}` : `c:${name}`;
  const prev = lanes.get(laneKey) || Promise.resolve();
  const tail = prev.then(async () => {
    await acquireSlot();
    job.status = 'running';
    job.startedAt = Date.now();
    emit('change', publicJob(job));
    let outcome;
    try {
      outcome = await job.execute(job);
    } catch (err) {
      outcome = { success: false, message: err.message };
    } finally {
      releaseSlot();
    }
    job.status = 'done';
    job.finishedAt = Date.now();
    job.success = Boolean(outcome?.success);
    job.message = outcome?.message ?? '';
    emit('change', publicJob(job));
    settleBatch(job.batchId);
  });
  lanes.set(laneKey, tail);
  tail.finally(() => {
    if (lanes.get(laneKey) === tail) lanes.delete(laneKey);
  });

  emit('change', publicJob(job));
  return publicJob(job);
}

/** Start a batch; enqueue its jobs with the returned id. */
export function startBatch() {
  const id = `b${Date.now().toString(36)}${(++seq).toString(36)}`;
  batches.set(id, { id, names: [], startedAt: Date.now(), finishedAt: null });
  return id;
}

function batchSummary(b) {
  const list = b.names.map((n) => jobs.get(n)).filter((j) => j && j.batchId === b.id);
  const done = list.filter((j) => j.status === 'done');
  return {
    id: b.id,
    total: list.length,
    done: done.length,
    succeeded: done.filter((j) => j.success).map((j) => j.name),
    failed: done.filter((j) => !j.success).map((j) => ({ name: j.name, message: j.message })),
    startedAt: b.startedAt,
    finishedAt: b.finishedAt,
  };
}

/** Close a batch with no more jobs to add (fires onBatchDone if all are already done). */
export function sealBatch(batchId) {
  const b = batches.get(batchId);
  if (!b) return;
  b.sealed = true;
  settleBatch(batchId);
}

function settleBatch(batchId) {
  const b = batchId && batches.get(batchId);
  if (!b || !b.sealed || b.finishedAt) return;
  const s = batchSummary(b);
  if (s.done < s.total) return;
  b.finishedAt = Date.now();
  emit('batchDone', batchSummary(b));
  emit('change', null);
}

/**
 * Current state for clients: queued/running jobs plus those finished within
 * the retention window, and the most recent batch (if still relevant).
 */
export function snapshot(now = Date.now()) {
  const list = [];
  for (const [name, j] of jobs) {
    if (j.status === 'done' && now - j.finishedAt > RETAIN_MS) {
      jobs.delete(name);
      continue;
    }
    list.push(publicJob(j));
  }
  let latest = null;
  for (const [id, b] of batches) {
    if (b.finishedAt && now - b.finishedAt > RETAIN_MS) {
      batches.delete(id);
      continue;
    }
    if (!latest || b.startedAt > latest.startedAt) latest = b;
  }
  return { jobs: list.sort((a, b) => a.queuedAt - b.queuedAt), batch: latest ? batchSummary(latest) : null };
}

/** Test hook: wait until every lane is idle. */
export async function _drain() {
  while (lanes.size) await Promise.all([...lanes.values()]);
}

/** Test hook: forget everything. */
export function _reset() {
  jobs.clear();
  batches.clear();
}

export default { enqueue, isBusy, startBatch, sealBatch, snapshot, onChange, onBatchDone };
