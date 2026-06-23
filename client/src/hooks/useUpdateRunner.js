import { useCallback, useEffect, useRef, useState } from 'react';
import { startUpdate } from '../api.js';
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

  const settle = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    onSettled(name);
    if (resolveRef.current) {
      resolveRef.current();
      resolveRef.current = null;
    }
  }, [name, onSettled]);

  const run = useCallback(() => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      settledRef.current = false;
      setStartError('');
      setStatus({ type: '', message: '' });
      reset();
      setStarting(true);
      startUpdate(name)
        .then(() => {
          setStreamActive(true);
          setStatus({ type: 'pending', message: 'Update started…' });
        })
        .catch((err) => {
          setStartError(err.message || 'Failed to start update');
          settle();
        })
        .finally(() => setStarting(false));
    });
  }, [name, reset, settle]);

  useEffect(() => {
    if (!result) return;
    setStreamActive(false);
    setStatus({
      type: result.success ? 'success' : 'error',
      message: result.message || (result.success ? 'Updated successfully' : 'Update failed'),
    });
    settle();
  }, [result, settle]);

  useEffect(() => {
    if (!sseError) return;
    // If the result already arrived, a subsequent stream error (e.g. the
    // server closing the connection) is expected — don't clobber the result.
    if (result || settledRef.current) return;
    setStreamActive(false);
    setStatus({ type: 'error', message: sseError });
    settle();
  }, [sseError, result, settle]);

  const busy = starting || streamActive;

  return { run, busy, starting, startError, status, lines };
}
