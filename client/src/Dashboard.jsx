import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getContainers, checkNow } from './api.js';
import UpdateCard from './components/UpdateCard.jsx';
import UpdateAllButton from './components/UpdateAllButton.jsx';

export default function Dashboard({ onPendingCountChange }) {
  const [containers, setContainers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState('');

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

  // Actively ask the server to re-check registries, then refresh the list.
  const handleCheck = useCallback(async () => {
    setChecking(true);
    setCheckMsg('');
    try {
      const r = await checkNow();
      await load();
      const checked = r?.checked ?? 0;
      const found = r?.updatesFound ?? 0;
      const errs = r?.errors ?? 0;
      setCheckMsg(
        `Checked ${checked} image${checked === 1 ? '' : 's'} — ${found} update${found === 1 ? '' : 's'} found` +
          (errs ? `, ${errs} couldn't be checked` : '') +
          '.'
      );
    } catch (err) {
      setCheckMsg(err.message || 'Check failed');
    } finally {
      setChecking(false);
    }
  }, [load]);

  // Live updates: refresh automatically when the server signals a change
  // (a Diun webhook arrived, a check ran, or an update finished).
  useEffect(() => {
    let es;
    let debounce;
    try {
      es = new EventSource('/api/events');
      es.onmessage = (e) => {
        let payload;
        try {
          payload = JSON.parse(e.data);
        } catch {
          return;
        }
        if (payload && payload.type === 'containers-changed') {
          clearTimeout(debounce);
          debounce = setTimeout(() => load(), 400);
        }
      };
    } catch {
      // EventSource unavailable — manual Refresh/Check still work.
    }
    return () => {
      clearTimeout(debounce);
      if (es) es.close();
    };
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
          <button type="button" className="btn btn-sm" onClick={handleCheck} disabled={checking || loading}>
            {checking && <span className="spinner" aria-hidden="true" />}
            Check
          </button>
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
      {checkMsg && <p className="check-msg">{checkMsg}</p>}

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
