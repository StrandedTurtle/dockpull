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

  const run = useCallback(() => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
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
          if (resolveRef.current) {
            resolveRef.current();
            resolveRef.current = null;
          }
          onSettled(name);
        })
        .finally(() => setStarting(false));
    });
  }, [name, reset, onSettled]);

  useEffect(() => {
    if (!result) return;
    setStreamActive(false);
    setStatus({
      type: result.success ? 'success' : 'error',
      message: result.message || (result.success ? 'Updated successfully' : 'Update failed'),
    });
    onSettled(name);
    if (resolveRef.current) {
      resolveRef.current();
      resolveRef.current = null;
    }
  }, [result, name, onSettled]);

  useEffect(() => {
    if (!sseError) return;
    setStatus({ type: 'error', message: sseError });
    onSettled(name);
    if (resolveRef.current) {
      resolveRef.current();
      resolveRef.current = null;
    }
  }, [sseError, name, onSettled]);

  const busy = starting || streamActive;

  return { run, busy, starting, startError, status, lines };
}
