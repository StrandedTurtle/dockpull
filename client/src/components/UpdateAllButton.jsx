import React, { useCallback, useState } from 'react';

/**
 * "Update all": hands the list of containers with a pending update to the
 * server, which queues and runs them itself (one at a time within each stack,
 * stacks in parallel). Nothing here needs to stay open — leaving the page or
 * locking the phone doesn't stop the batch — and progress comes back from the
 * server's batch (`batch` from the app-wide live state).
 *
 * props:
 *  - targets: [{ name, project }]
 *  - onStart(names): starts the batch (POST /api/update-all)
 *  - batch: the server's current batch summary, or null
 */
export default function UpdateAllButton({ targets, onStart, batch, disabled }) {
  const [starting, setStarting] = useState(false);
  const running = Boolean(batch && !batch.finishedAt);

  const handleClick = useCallback(async () => {
    if (starting || running || disabled || targets.length === 0) return;
    setStarting(true);
    try {
      await onStart(targets.map((t) => t.name));
    } finally {
      setStarting(false);
    }
  }, [starting, running, disabled, targets, onStart]);

  return (
    <button
      type="button"
      className="btn btn-primary btn-sm"
      onClick={handleClick}
      disabled={disabled || starting || running || targets.length === 0}
    >
      {(starting || running) && <span className="spinner" aria-hidden="true" />}
      {running ? `${batch.done}/${batch.total} done` : 'Update all'}
    </button>
  );
}
