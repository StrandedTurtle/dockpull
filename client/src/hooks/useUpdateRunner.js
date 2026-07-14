import { useCallback, useEffect, useRef, useState } from 'react';
import { startUpdate, revertUpdate } from '../api.js';
import { useSSE } from './useSSE.js';

/**
 * Owns the full lifecycle of "update this one container": POST the start
 * request, then stream logs/result over SSE, exposing a single `run()`
 * promise that resolves once the terminal SSE event (or a failure) has
 * been handled. Used by both the per-card Update button and the
 * "Update all" sequential batch (so both go through the exact same flow).
 *
 * `onSettled(name)` is called once, after the update finishes (success,
 * failure, or stream error), so the dashboard can re-fetch the container
 * list and clear its in-flight bookkeeping.
 */
export function useUpdateRunner(name, onSettled) {
  const [streamActive, setStreamActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [status, setStatus] = useState({ type: '', message: '' });

  const { lines, result, error: sseError, reset } = useSSE(name, streamActive);

  const resolveRef = useRef(null);
  // Ensures we settle (resolve the run promise + notify the dashboard) exactly
  // once per run, so a connection error arriving after the result can't
  // overwrite a success or trigger a second re-fetch.
  const settledRef = useRef(false);
  // The in-flight run's promise, if any. `run()` can be invoked through
  // multiple paths (the per-card button, "Update all"'s sequential loop) --
  // without this, a second call while one is already running would fire a
  // second POST /api/update/:name and the server would correctly reject it
  // with 409, surfacing as a spurious error even though the first call
  // succeeds. Returning the same promise instead makes every caller await
  // the one real update.
  const pendingRunRef = useRef(null);

  const settle = useCallback(
    (outcome) => {
      if (settledRef.current) return;
      settledRef.current = true;
      pendingRunRef.current = null;
      onSettled(name);
      if (resolveRef.current) {
        // Resolve the run() promise with the outcome so batch callers
        // ("Update all") can summarize successes/failures per container.
        resolveRef.current(outcome || { success: false, message: '' });
        resolveRef.current = null;
      }
    },
    [name, onSettled]
  );

  // Shared start path for both "update" and "revert" — same SSE stream + result
  // handling, only the kickoff request and the pending message differ.
  const start = useCallback(
    (starter, pendingMsg) => {
      if (pendingRunRef.current) return pendingRunRef.current;
      const promise = new Promise((resolve) => {
        resolveRef.current = resolve;
        settledRef.current = false;
        setStartError('');
        setStatus({ type: '', message: '' });
        reset();
        setStarting(true);
        starter(name)
          .then(() => {
            setStreamActive(true);
            setStatus({ type: 'pending', message: pendingMsg });
          })
          .catch((err) => {
            setStartError(err.message || 'Failed to start');
            settle({ success: false, message: err.message || 'Failed to start' });
          })
          .finally(() => setStarting(false));
      });
      pendingRunRef.current = promise;
      return promise;
    },
    [name, reset, settle]
  );

  const run = useCallback(() => start(startUpdate, 'Update started…'), [start]);
  const revert = useCallback(() => start(revertUpdate, 'Reverting…'), [start]);

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
    // If the result already arrived, a subsequent stream error (e.g. the
    // server closing the connection) is expected — don't clobber the result.
    if (result || settledRef.current) return;
    setStreamActive(false);
    setStatus({ type: 'error', message: sseError });
    settle({ success: false, message: sseError });
  }, [sseError, result, settle]);

  const busy = starting || streamActive;

  return { run, revert, busy, starting, startError, status, lines };
}
