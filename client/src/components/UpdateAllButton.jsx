import React, { useCallback, useState } from 'react';

/**
 * Updates every container with `updateAvailable && !pinned`. Containers in the
 * same stack (compose project) run one at a time — concurrent `docker compose
 * up` calls against one project can race on its shared networks and
 * dependencies — while different stacks proceed in parallel. A failure on one
 * container does not stop the others: `runUpdate` resolves (never rejects)
 * with the outcome.
 *
 * `targets` is `[{ name, project }]`. Disabled when there are no eligible
 * targets or any update is in flight.
 */
export default function UpdateAllButton({ targets, runUpdate, disabled, onBatchDone }) {
  const [running, setRunning] = useState(false);

  const handleClick = useCallback(async () => {
    if (running || disabled || targets.length === 0) return;
    setRunning(true);
    const runOne = (name) =>
      Promise.resolve(runUpdate(name))
        .then((r) => ({ name, success: !!(r && r.success), message: (r && r.message) || '' }))
        .catch((err) => ({ name, success: false, message: err?.message || '' }));

    // One sequential lane per stack; standalone containers each get their own.
    const lanes = new Map();
    for (const t of targets) {
      const key = t.project ? `p:${t.project}` : `c:${t.name}`;
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push(t.name);
    }
    // Each run() resolves with { success, message }, so the dashboard can show
    // one aggregate summary instead of making the user scroll every card.
    const laneOutcomes = await Promise.all(
      [...lanes.values()].map(async (names) => {
        const out = [];
        for (const name of names) out.push(await runOne(name));
        return out;
      })
    );
    const outcomes = laneOutcomes.flat();
    setRunning(false);
    if (onBatchDone) onBatchDone(outcomes);
  }, [running, disabled, targets, runUpdate, onBatchDone]);

  return (
    <button
      type="button"
      className="btn btn-primary btn-sm"
      onClick={handleClick}
      disabled={disabled || running || targets.length === 0}
    >
      {running && <span className="spinner" aria-hidden="true" />}
      Update all
    </button>
  );
}
