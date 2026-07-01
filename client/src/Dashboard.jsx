import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getContainers, checkNow, getSettings, updateSettings, getStatus } from './api.js';
import UpdateCard from './components/UpdateCard.jsx';
import UpdateAllButton from './components/UpdateAllButton.jsx';
import StackGroup from './components/StackGroup.jsx';

const AUTOCHECK_SESSION = 'dockpull.autochecked';
const UNGROUPED = 'Ungrouped';

// Compact "x ago" for the last-checked line.
function timeAgo(ts) {
  if (!ts) return null;
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

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

// Suggested same-path mount derived from a broken compose file path: the
// directory above the per-stack folder (e.g. /opt/stacks/web/compose.yaml ->
// /opt/stacks).
function stacksRootOf(composeFile) {
  if (!composeFile) return null;
  const parts = composeFile.split('/');
  parts.pop(); // file name
  parts.pop(); // stack folder
  const root = parts.join('/');
  return root || '/';
}

export default function Dashboard({ onPendingCountChange }) {
  const [containers, setContainers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState('');
  const [filter, setFilter] = useState('updates');
  const [lastCheckedAt, setLastCheckedAt] = useState(null);

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
      setLastCheckedAt(Date.now());
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

  // Seed the "last checked" time from the server's persisted last check.
  useEffect(() => {
    getStatus()
      .then((s) => {
        if (s?.lastCheck?.at) setLastCheckedAt((prev) => prev || s.lastCheck.at);
      })
      .catch(() => {});
  }, []);

  // Initial load + settings + auto-check on first open this session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [settingsResult] = await Promise.allSettled([getSettings(), load()]);
      if (cancelled) return;
      setLoading(false);

      const settings =
        settingsResult.status === 'fulfilled' && settingsResult.value
          ? settingsResult.value
          : { defaultFilter: 'updates', autoCheckOnOpen: true };
      setFilter(settings.defaultFilter === 'all' ? 'all' : 'updates');

      let alreadyChecked = false;
      try {
        alreadyChecked = sessionStorage.getItem(AUTOCHECK_SESSION) === '1';
      } catch {
        alreadyChecked = false;
      }
      if (settings.autoCheckOnOpen !== false && !alreadyChecked) {
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
    updateSettings({ defaultFilter: value }).catch(() => {
      // non-fatal: the view still changes even if persisting the default fails
    });
  }, []);

  // Pinned go to their own bottom section; everything else is the main list.
  const visible = containers;
  const pinnedItems = useMemo(
    () => visible.filter((c) => c.pinned).sort((a, b) => a.name.localeCompare(b.name)),
    [visible]
  );
  const mainItems = useMemo(() => visible.filter((c) => !c.pinned), [visible]);

  const pendingTargets = useMemo(() => mainItems.filter(hasUpdate).map((c) => c.name), [mainItems]);

  useEffect(() => {
    if (onPendingCountChange) onPendingCountChange(pendingTargets.length);
  }, [pendingTargets, onPendingCountChange]);

  // Apply the filter, then group by stack (compose project); groups with
  // updates come first.
  const groups = useMemo(() => {
    const items = filter === 'updates' ? mainItems.filter(hasUpdate) : mainItems;
    const byProject = new Map();
    for (const c of items) {
      const key = c.project || UNGROUPED;
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(c);
    }
    const out = [];
    for (const [project, groupItems] of byProject) {
      groupItems.sort(byUpdateThenName);
      out.push({ project, items: groupItems, updateCount: groupItems.filter(hasUpdate).length });
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
  }, [mainItems, filter]);

  const mainCount = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups]);

  // Mount/diagnostic banner: any compose file unreachable inside the container.
  const mountIssue = useMemo(() => {
    const broken = containers.find((c) => c.composeFileMissing && c.composeFile);
    if (!broken) return null;
    return { example: broken.composeFile, root: stacksRootOf(broken.composeFile) };
  }, [containers]);

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
        {lastCheckedAt ? <span className="dashboard-lastcheck"> · Last checked {timeAgo(lastCheckedAt)}</span> : null}
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

      {mountIssue && (
        <div className="banner banner-warn" role="alert">
          <strong>Some stacks aren't mounted.</strong> The compose file{' '}
          <code>{mountIssue.example}</code> isn't reachable inside this container, so those
          updates will fail. Mount your stacks directory at the same absolute path on the host
          and in the container
          {mountIssue.root ? (
            <>
              {' '}(e.g. <code>{mountIssue.root}:{mountIssue.root}</code>)
            </>
          ) : null}{' '}
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

      {!loading && !error && visible.length === 0 && (
        <div className="empty-state">
          <p>No containers found.</p>
        </div>
      )}

      {!loading && !error && visible.length > 0 && mainCount === 0 && (
        <div className="empty-state">
          <p>Everything's up to date. 🎉</p>
          {filter === 'updates' && (
            <button type="button" className="btn btn-sm" onClick={() => setFilterPersisted('all')}>
              Show all containers
            </button>
          )}
        </div>
      )}

      {!loading && !error && mainCount > 0 && (
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

      {!loading && !error && pinnedItems.length > 0 && (
        <div className="dashboard-groups pinned-groups">
          <StackGroup
            title="Pinned versions"
            count={pinnedItems.length}
            storageKey="__pinned__"
            defaultOpen={false}
          >
            <div className="dashboard-list">
              {pinnedItems.map((container) => (
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
        </div>
      )}
    </div>
  );
}
