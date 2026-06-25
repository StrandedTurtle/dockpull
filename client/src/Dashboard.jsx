import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getContainers, checkNow, getDiagnostics } from './api.js';
import UpdateCard from './components/UpdateCard.jsx';
import UpdateAllButton from './components/UpdateAllButton.jsx';
import StackGroup from './components/StackGroup.jsx';

const FILTER_KEY = 'diun.filter';
const AUTOCHECK_KEY = 'diun.autoCheckOnOpen';
const AUTOCHECK_SESSION = 'diun.autochecked';
const UNGROUPED = 'Ungrouped';

function hasUpdate(c) {
  return c.updateAvailable && !c.pinned;
}

// Sort: containers needing an update first, then by name.
function byUpdateThenName(a, b) {
  const au = hasUpdate(a) ? 0 : 1;
  const bu = hasUpdate(b) ? 0 : 1;
  if (au !== bu) return au - bu;
  return a.name.localeCompare(b.name);
}

export default function Dashboard({ onPendingCountChange }) {
  const [containers, setContainers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState('');
  const [stacksWarning, setStacksWarning] = useState(null); // {stacksDir} when not mounted
  const [filter, setFilter] = useState(() => {
    try {
      return localStorage.getItem(FILTER_KEY) || 'updates';
    } catch {
      return 'updates';
    }
  });

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

  // Actively ask the server to re-check registries, then refresh the list.
  const check = useCallback(async () => {
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

  // Initial load + auto-check on first open this session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await load();
      if (cancelled) return;
      setLoading(false);

      let autoCheck = true;
      try {
        autoCheck = localStorage.getItem(AUTOCHECK_KEY) !== '0';
      } catch {
        autoCheck = true;
      }
      let alreadyChecked = false;
      try {
        alreadyChecked = sessionStorage.getItem(AUTOCHECK_SESSION) === '1';
      } catch {
        alreadyChecked = false;
      }
      if (autoCheck && !alreadyChecked) {
        try {
          sessionStorage.setItem(AUTOCHECK_SESSION, '1');
        } catch {
          // ignore
        }
        check();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Surface a mount-misconfig warning so the user can fix it before an update
  // fails with a cryptic "compose file not found".
  useEffect(() => {
    getDiagnostics()
      .then((d) => {
        if (d?.stacks && d.stacks.mounted === false) {
          setStacksWarning({ stacksDir: d.stacks.stacksDir });
        } else {
          setStacksWarning(null);
        }
      })
      .catch(() => setStacksWarning(null));
  }, []);

  // Live updates: refresh automatically when the server signals a change.
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
      // EventSource unavailable — manual Check still works.
    }
    return () => {
      clearTimeout(debounce);
      if (es) es.close();
    };
  }, [load]);

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

  const setFilterPersisted = useCallback((value) => {
    setFilter(value);
    try {
      localStorage.setItem(FILTER_KEY, value);
    } catch {
      // ignore
    }
  }, []);

  const pendingTargets = useMemo(() => containers.filter(hasUpdate).map((c) => c.name), [containers]);

  useEffect(() => {
    if (onPendingCountChange) onPendingCountChange(pendingTargets.length);
  }, [pendingTargets, onPendingCountChange]);

  // Apply the filter, then group by stack (compose project), then order groups
  // so those with updates come first.
  const groups = useMemo(() => {
    const visible = filter === 'updates' ? containers.filter(hasUpdate) : containers;
    const byProject = new Map();
    for (const c of visible) {
      const key = c.project || UNGROUPED;
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(c);
    }
    const out = [];
    for (const [project, items] of byProject) {
      items.sort(byUpdateThenName);
      out.push({
        project,
        items,
        updateCount: items.filter(hasUpdate).length,
      });
    }
    out.sort((a, b) => {
      const au = a.updateCount > 0 ? 0 : 1;
      const bu = b.updateCount > 0 ? 0 : 1;
      if (au !== bu) return au - bu;
      if (a.project === UNGROUPED) return 1;
      if (b.project === UNGROUPED) return -1;
      return a.project.localeCompare(b.project);
    });
    return out;
  }, [containers, filter]);

  const totalVisible = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups]);

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
          <button type="button" className="btn btn-primary btn-sm" onClick={check} disabled={checking || loading}>
            {checking && <span className="spinner" aria-hidden="true" />}
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
          <UpdateAllButton targets={pendingTargets} runUpdate={runUpdateFor} disabled={loading || !!error} />
        </div>
      </div>

      <p className="dashboard-subtitle">
        Queries each image's registry for a newer version — nothing is pulled until you tap Update.
      </p>

      <div className="filter-row" role="group" aria-label="Filter containers">
        <button
          type="button"
          className={`chip${filter === 'updates' ? ' is-active' : ''}`}
          onClick={() => setFilterPersisted('updates')}
          aria-pressed={filter === 'updates'}
        >
          Updates only
        </button>
        <button
          type="button"
          className={`chip${filter === 'all' ? ' is-active' : ''}`}
          onClick={() => setFilterPersisted('all')}
          aria-pressed={filter === 'all'}
        >
          All
        </button>
      </div>

      {checkMsg && <p className="check-msg">{checkMsg}</p>}

      {stacksWarning && (
        <div className="banner banner-warn" role="alert">
          <strong>Stacks directory not mounted.</strong> The path{' '}
          <code>{stacksWarning.stacksDir}</code> isn't present inside this container, so
          compose-based updates will fail. Mount your stacks dir at the same absolute path on
          the host and in the container (e.g. <code>{stacksWarning.stacksDir}:{stacksWarning.stacksDir}</code>)
          and set <code>STACKS_DIR</code> to match. See the README.
        </div>
      )}

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
          <button type="button" className="btn btn-primary" onClick={load}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && containers.length === 0 && (
        <div className="empty-state">
          <p>No containers found.</p>
        </div>
      )}

      {!loading && !error && containers.length > 0 && totalVisible === 0 && (
        <div className="empty-state">
          <p>Everything's up to date. 🎉</p>
          <button type="button" className="btn btn-sm" onClick={() => setFilterPersisted('all')}>
            Show all containers
          </button>
        </div>
      )}

      {!loading && !error && totalVisible > 0 && (
        <div className="dashboard-groups">
          {groups.map((g) => (
            <StackGroup
              key={g.project}
              title={g.project}
              count={g.items.length}
              updateCount={g.updateCount}
              storageKey={g.project}
              defaultOpen={g.updateCount > 0 || filter === 'updates'}
            >
              <div className="dashboard-list">
                {g.items.map((container) => (
                  <UpdateCard
                    key={container.name}
                    container={container}
                    onSettled={handleSettled}
                    onPinChange={load}
                    registerRunner={registerRunner}
                  />
                ))}
              </div>
            </StackGroup>
          ))}
        </div>
      )}
    </div>
  );
}
