import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getContainers } from './api.js';
import UpdateCard from './components/UpdateCard.jsx';
import UpdateAllButton from './components/UpdateAllButton.jsx';

export default function Dashboard({ onPendingCountChange }) {
  const [containers, setContainers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // name -> run() function, populated by each UpdateCard so "Update all"
  // can drive the same start+SSE flow the per-card button uses.
  const runnersRef = useRef(new Map());

  const load = useCallback(async () => {
    setError('');
    try {
      const data = await getContainers();
      setContainers(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message || 'Failed to load containers');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Called by UpdateCard once its update settles (success/error/stream
  // error). Re-fetch so digests/updateAvailable/pinned reflect server state.
  const handleSettled = useCallback(() => {
    load();
  }, [load]);

  const registerRunner = useCallback((name, runFn) => {
    if (runFn) {
      runnersRef.current.set(name, runFn);
    } else {
      runnersRef.current.delete(name);
    }
  }, []);

  const runUpdateFor = useCallback((name) => {
    const runFn = runnersRef.current.get(name);
    if (!runFn) return Promise.resolve();
    return runFn();
  }, []);

  const pendingTargets = useMemo(
    () => containers.filter((c) => c.updateAvailable && !c.pinned).map((c) => c.name),
    [containers]
  );

  useEffect(() => {
    if (onPendingCountChange) onPendingCountChange(pendingTargets.length);
  }, [pendingTargets, onPendingCountChange]);

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <div className="title-row">
          <h2>Containers</h2>
          {pendingTargets.length > 0 ? (
            <span className="badge">{pendingTargets.length}</span>
          ) : (
            !loading && <span className="badge badge-muted">0</span>
          )}
        </div>
        <div className="dashboard-actions">
          <button type="button" className="btn btn-sm" onClick={handleRefresh} disabled={refreshing || loading}>
            {refreshing && <span className="spinner" aria-hidden="true" />}
            Refresh
          </button>
          <UpdateAllButton
            targets={pendingTargets}
            runUpdate={runUpdateFor}
            disabled={loading || !!error}
          />
        </div>
      </div>

      {loading && (
        <div className="dashboard-list" aria-busy="true" aria-label="Loading containers">
          <div className="skeleton-card" />
          <div className="skeleton-card" />
          <div className="skeleton-card" />
        </div>
      )}

      {!loading && error && (
        <div className="error-state">
          <p>{error}</p>
          <button type="button" className="btn btn-primary" onClick={handleRefresh}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && containers.length === 0 && (
        <div className="empty-state">
          <p>No containers found.</p>
        </div>
      )}

      {!loading && !error && containers.length > 0 && (
        <div className="dashboard-list">
          {containers.map((container) => (
            <UpdateCard
              key={container.name}
              container={container}
              onSettled={handleSettled}
              onPinChange={load}
              registerRunner={registerRunner}
            />
          ))}
        </div>
      )}
    </div>
  );
}
