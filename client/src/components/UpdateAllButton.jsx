import React, { useCallback, useState } from 'react';

/**
 * Updates every container with `updateAvailable && !pinned`, all at once:
 * each is started immediately and its own SSE stream runs concurrently
 * (handled by `runUpdate`). A failure on one container does not affect the
 * others — `runUpdate` resolves (not rejects) even on failure, and
 * `Promise.allSettled` waits for them all regardless.
 *
 * Disabled when there are no eligible targets or any update is in flight.
 */
export default function UpdateAllButton({ targets, runUpdate, disabled, onBatchDone }) {
  const [running, setRunning] = useState(false);

  const handleClick = useCallback(async () => {
    if (running || disabled || targets.length === 0) return;
    setRunning(true);
    // Fire them all immediately, then wait for the whole batch to settle.
    // Each run() resolves (never rejects) with { success, message }, so the
    // dashboard can show one aggregate summary instead of making the user
    // scroll every card to find what failed.
    const outcomes = await Promise.all(
      targets.map((name) =>
        Promise.resolve(runUpdate(name))
          .then((r) => ({ name, success: !!(r && r.success), message: (r && r.message) || '' }))
          .catch((err) => ({ name, success: false, message: err?.message || '' }))
      )
    );
    setRunning(false);
    if (onBatchDone) onBatchDone(outcomes);
  }, [running, disabled, targets, runUpdate, onBatchDone]);

  return (
    <button
      type="button"
      className="btn btn-primary"
      onClick={handleClick}
      disabled={disabled || running || targets.length === 0}
    >
      {running && <span className="spinner" aria-hidden="true" />}
      Update all
    </button>
  );
}
