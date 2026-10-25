import { useCallback, useEffect, useRef, useState } from 'react';
import { startUpdate, revertUpdate, switchTag } from '../api.js';
import { useSSE } from './useSSE.js';

const KIND_LABEL = {
  update: 'Updating…',
  revert: 'Reverting…',
  switch: 'Switching tag…',
};

function pendingMessage(job) {
  if (!job) return 'Starting…';
  if (job.status === 'queued') {
    return job.waitingOn === 'stack'
      ? 'Queued — waiting for other updates in this stack…'
      : 'Queued — waiting for its turn…';
  }
  if (job.kind === 'switch' && job.tag) return `Switching to ${job.tag}…`;
  return KIND_LABEL[job.kind] || 'Updating…';
}

/**
 * One container's update / revert / tag switch, as seen from its card.
 *
 * The work runs on the server (a queued job — see server/src/jobs.js); this
 * hook starts it and follows its live log over SSE. It also follows a job it
 * did NOT start — from "Update all", another device, or before the user left
 * this page — via the `job` prop (from the app-wide live state): whenever a
 * new job id shows up for this container, it (re)attaches to the stream, which
 * the server replays from the beginning.
 *
 * `onSettled(name)` runs once per job when it finishes, so the dashboard can
 * refresh.
 */
export function useUpdateRunner(name, onSettled, job = null) {
  const [streamActive, setStreamActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [status, setStatus] = useState({ type: '', message: '' });

  const { lines, result, error: sseError, reset } = useSSE(name, streamActive);

  // The job id this card is currently showing, so each job attaches once.
  const attachedJobRef = useRef(null);
  // Settle exactly once per job (a stream error after the result mustn't
  // overwrite it or trigger a second refresh).
  const settledRef = useRef(true);
  const resolveRef = useRef(null);
  const pendingRunRef = useRef(null);

  const settle = useCallback(
    (outcome) => {
      if (settledRef.current) return;
      settledRef.current = true;
      pendingRunRef.current = null;
      onSettled(name);
      if (resolveRef.current) {
        resolveRef.current(outcome || { success: false, message: '' });
        resolveRef.current = null;
      }
    },
    [name, onSettled]
  );

  const attach = useCallback(
    (jobInfo) => {
      settledRef.current = false;
      reset();
      setStartError('');
      setStatus({ type: 'pending', message: pendingMessage(jobInfo) });
      setStreamActive(true);
    },
    [reset]
  );

  // Start a job from this card. Returns a promise resolved when it finishes.
  const start = useCallback(
    (starter) => {
      if (pendingRunRef.current) return pendingRunRef.current;
      const promise = new Promise((resolve) => {
        resolveRef.current = resolve;
        settledRef.current = false;
        setStartError('');
        setStatus({ type: 'pending', message: 'Starting…' });
        reset();
        setStarting(true);
        starter(name)
          .then((r) => {
            attachedJobRef.current = r?.job?.id ?? attachedJobRef.current;
            attach(r?.job);
          })
          .catch((err) => {
            setStatus({ type: '', message: '' });
            setStartError(err.message || 'Failed to start');
            settle({ success: false, message: err.message || 'Failed to start' });
          })
          .finally(() => setStarting(false));
      });
      pendingRunRef.current = promise;
      return promise;
    },
    [name, reset, settle, attach]
  );

  const run = useCallback(() => start(startUpdate), [start]);
  const revert = useCallback(() => start(revertUpdate), [start]);
  const switchTo = useCallback((tag) => start((n) => switchTag(n, tag)), [start]);

  // Follow server-side jobs this card didn't start (or after a page change).
  useEffect(() => {
    if (!job || attachedJobRef.current === job.id) {
      // Same job: keep the pending message current (queued -> running).
      if (job && streamActive && (job.status === 'queued' || job.status === 'running')) {
        setStatus((s) => (s.type === 'pending' ? { type: 'pending', message: pendingMessage(job) } : s));
      }
      return;
    }
    if (pendingRunRef.current && starting) return; // our own start; its response attaches
    // The server keeps a finished job's log for 15 minutes; past that there's
    // nothing to replay (History has it).
    if (job.status === 'done' && Date.now() - (job.finishedAt || 0) > 14 * 60_000) return;
    attachedJobRef.current = job.id;
    attach(job);
  }, [job, streamActive, starting, attach]);

  useEffect(() => {
    if (!result) return;
    setStreamActive(false);
    setStatus({
      type: result.success ? 'success' : 'error',
      message: result.message || (result.success ? 'Updated successfully' : 'Update failed'),
    });
    settle({ success: !!result.success, message: result.message || '' });
  }, [result, settle]);

  useEffect(() => {
    if (!sseError) return;
    if (result || settledRef.current) return;
    setStreamActive(false);
    // The live log was lost, but the job may still be fine — show what the
    // server last reported rather than claiming a failure.
    if (job && job.status === 'done') {
      setStatus({ type: job.success ? 'success' : 'error', message: job.message || '' });
      settle({ success: !!job.success, message: job.message || '' });
    } else {
      setStatus({ type: 'error', message: sseError });
      settle({ success: false, message: sseError });
    }
  }, [sseError, result, settle, job]);

  const jobActive = Boolean(job && (job.status === 'queued' || job.status === 'running'));
  const busy = starting || streamActive || jobActive;

  return { run, revert, switchTo, busy, starting, startError, status, lines };
}
