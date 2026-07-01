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
export default function UpdateAllButton({ targets, runUpdate, disabled }) {
  const [running, setRunning] = useState(false);

  const handleClick = useCallback(async () => {
    if (running || disabled || targets.length === 0) return;
    setRunning(true);
    // Fire them all immediately, then wait for the whole batch to settle.
    await Promise.allSettled(targets.map((name) => runUpdate(name)));
    setRunning(false);
  }, [running, disabled, targets, runUpdate]);

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
