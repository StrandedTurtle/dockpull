import React, { useCallback, useState } from 'react';

/**
 * Updates every container with `updateAvailable && !pinned`, sequentially:
 * each one is started and fully awaited (start + SSE stream to completion,
 * handled by `runUpdate`) before the next one begins. A failure on one
 * container does not stop the batch — `runUpdate` is expected to resolve
 * (not reject) even on failure, so this loop always continues.
 *
 * Disabled when there are no eligible targets or any update is in flight.
 */
export default function UpdateAllButton({ targets, runUpdate, disabled }) {
  const [running, setRunning] = useState(false);

  const handleClick = useCallback(async () => {
    if (running || disabled || targets.length === 0) return;
    setRunning(true);
    for (const name of targets) {
      try {
        await runUpdate(name);
      } catch {
        // Swallow — a failure for one container must not stop the batch.
      }
    }
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
