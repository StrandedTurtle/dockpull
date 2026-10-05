import React, { useCallback, useEffect, useState } from 'react';
import {
  get,
  getPinned,
  unpin,
  getSettings,
  updateSettings,
  testNotify,
  getStatus,
  getDanglingImages,
  pruneImages,
  logoutAll,
  restoreBackup,
  API_BASE,
} from '../api.js';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { useTheme } from '../hooks/useTheme.js';

// Human-readable byte count: whole bytes below 1 KB, one decimal above.
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = -1;
  do {
    value /= 1024;
    i += 1;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(1)} ${units[i]}`;
}

// "in 3h", "in 25m", "at 09:00 tomorrow"-ish relative time for a future epoch ms.
function formatWhen(ts) {
  const ms = ts - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms < 60_000) return 'in under a minute';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24) return `in ${h}h${rest ? ` ${rest}m` : ''}`;
  return `on ${new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

// Rough relative age for an image's creation time (Docker's `created` is Unix
// seconds). Helps explain why some dangling layers show "Untracked source" —
// e.g. an old layer from a container's earlier update, before its rollback
// point got overwritten by a more recent one.
function formatAge(createdSeconds) {
  if (!Number.isFinite(createdSeconds)) return '—';
  const ms = Date.now() - createdSeconds * 1000;
  const days = Math.floor(ms / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

// Per-target label/description/placeholder for the notification URL field.
const NOTIFY_META = {
  discord: {
    label: 'Discord webhook URL',
    desc: 'Paste a Discord channel webhook URL.',
    placeholder: 'https://discord.com/api/webhooks/…',
  },
  ntfy: {
    label: 'ntfy topic URL',
    desc: 'Your ntfy topic URL (self-hosted or ntfy.sh).',
    placeholder: 'https://ntfy.sh/my-topic',
  },
  gotify: {
    label: 'Gotify message URL',
    desc: 'Your Gotify server message URL, including the app token.',
    placeholder: 'https://gotify.example.com/message?token=…',
  },
  webhook: {
    label: 'Webhook URL',
    desc: 'A URL that receives a JSON POST when updates are found.',
    placeholder: 'https://example.com/hook',
  },
};

export default function SettingsPage({ onPruneComplete } = {}) {
  const { theme, toggle } = useTheme();

  const [pinned, setPinned] = useState([]);
  const [pinnedLoading, setPinnedLoading] = useState(true);
  const [pinnedError, setPinnedError] = useState('');
  const [unpinningRef, setUnpinningRef] = useState('');

  const [settings, setSettings] = useState(null);
  const [settingsError, setSettingsError] = useState('');

  const [webhookDraft, setWebhookDraft] = useState('');
  const [webhookInit, setWebhookInit] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState('');

  const [confirmPrune, setConfirmPrune] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [pruneStatus, setPruneStatus] = useState('');
  const [pruneSummaryLoading, setPruneSummaryLoading] = useState(false);
  // Every prunable image from the preview, and the IDs the user has left out.
  // Revert points (images named after a container) start excluded: pruning
  // one removes that container's undo button, so it's opt-in.
  const [pruneCandidates, setPruneCandidates] = useState([]);
  const [pruneExcluded, setPruneExcluded] = useState(() => new Set());
  const pruneSelection = pruneCandidates.filter((img) => !pruneExcluded.has(img.id));

  const [health, setHealth] = useState(null); // null = unknown, true/false once checked
  const [status, setStatus] = useState(null); // { version, serverLocalTime, timeZone }

  const loadPinned = useCallback(async () => {
    setPinnedError('');
    try {
      const data = await getPinned();
      setPinned(Array.isArray(data) ? data : []);
    } catch (err) {
      setPinnedError(err.message || 'Failed to load pinned versions');
    }
  }, []);

  useEffect(() => {
    setPinnedLoading(true);
    loadPinned().finally(() => setPinnedLoading(false));
  }, [loadPinned]);

  useEffect(() => {
    getSettings()
      .then((s) => setSettings(s))
      .catch((err) => setSettingsError(err.message || 'Failed to load settings'));
  }, []);

  // Seed the webhook input once settings arrive.
  useEffect(() => {
    if (settings && !webhookInit) {
      setWebhookDraft(settings.discordWebhookUrl || '');
      setWebhookInit(true);
    }
  }, [settings, webhookInit]);

  useEffect(() => {
    get('/health')
      .then((data) => setHealth(!!(data && data.ok)))
      .catch(() => setHealth(false));
  }, []);

  const refreshStatus = useCallback(() => {
    getStatus()
      .then((s) => setStatus(s || null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // --- Account & data ---
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountStatus, setAccountStatus] = useState('');
  const [confirmLogoutAll, setConfirmLogoutAll] = useState(false);
  const [pendingRestore, setPendingRestore] = useState(null);

  const handleLogoutAll = useCallback(async () => {
    setConfirmLogoutAll(false);
    setAccountBusy(true);
    setAccountStatus('');
    try {
      await logoutAll();
      setAccountStatus('Signed out everywhere else. This device stays signed in.');
    } catch (err) {
      setAccountStatus(err.message || 'Failed to sign out other sessions');
    } finally {
      setAccountBusy(false);
    }
  }, []);

  const handleRestoreFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow picking the same file again
    if (!file) return;
    setAccountStatus('');
    try {
      const data = JSON.parse(await file.text());
      if (data?.format !== 'dockpull-backup') throw new Error("That file isn't a DockPull backup.");
      setPendingRestore(data);
    } catch (err) {
      setAccountStatus(err instanceof SyntaxError ? "That file isn't valid JSON." : err.message);
    }
  }, []);

  const handleRestoreConfirm = useCallback(async () => {
    const backup = pendingRestore;
    setPendingRestore(null);
    setAccountBusy(true);
    try {
      const r = await restoreBackup(backup);
      setAccountStatus(
        `Restored ${r.settings} settings, ${r.pinned} pinned, ${r.history} history entries` +
          (r.historySkippedBecauseNotEmpty ? ' (history kept as is — it already had entries)' : '') +
          (r.skipped ? `; skipped ${r.skipped} invalid entr${r.skipped === 1 ? 'y' : 'ies'}` : '') +
          '.'
      );
      const fresh = await getSettings();
      setSettings(fresh);
      setWebhookDraft(fresh?.discordWebhookUrl || '');
      refreshStatus();
    } catch (err) {
      setAccountStatus(err.message || 'Restore failed');
    } finally {
      setAccountBusy(false);
    }
  }, [pendingRestore, refreshStatus]);

  const saveSetting = useCallback(async (patch) => {
    setSettings((prev) => ({ ...prev, ...patch })); // optimistic
    setSettingsError('');
    try {
      const updated = await updateSettings(patch);
      setSettings(updated);
      return updated;
    } catch (err) {
      setSettingsError(err.message || 'Failed to save settings');
      throw err;
    }
  }, []);

  const runTest = useCallback(async () => {
    setTesting(true);
    setTestStatus('');
    try {
      if (settings && webhookDraft !== settings.discordWebhookUrl) {
        await saveSetting({ discordWebhookUrl: webhookDraft });
      }
      await testNotify(webhookDraft || undefined, settings?.notifyType);
      setTestStatus('Sent — check your notification target.');
    } catch (err) {
      setTestStatus(err.message || 'Test failed');
    } finally {
      setTesting(false);
    }
  }, [webhookDraft, settings, saveSetting]);

  const handlePruneClick = useCallback(async () => {
    setPruneStatus('');
    setPruneSummaryLoading(true);
    try {
      const summary = (await getDanglingImages()) || { count: 0, images: [] };
      if (!summary.count) {
        setPruneStatus('Nothing to prune — no dangling layers found.');
        return;
      }
      const images = summary.images || [];
      setPruneCandidates(images);
      setPruneExcluded(new Set(images.filter((img) => img.fromContainer).map((img) => img.id)));
      setConfirmPrune(true);
    } catch (err) {
      setPruneStatus(err.message || 'Failed to check for dangling layers');
    } finally {
      setPruneSummaryLoading(false);
    }
  }, []);

  // Drop a layer from this prune. It isn't removed, so it reappears the next
  // time the dialog is opened (which re-fetches the current dangling set).
  const togglePruneImage = useCallback((id) => {
    setPruneExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handlePrune = useCallback(async () => {
    const ids = pruneSelection.map((img) => img.id);
    setConfirmPrune(false);
    setPruning(true);
    setPruneStatus('');
    try {
      const { deleted = 0, spaceReclaimed = 0, revertsRemoved = [] } = (await pruneImages(ids)) || {};
      const revertNote = revertsRemoved.length
        ? ` Revert is no longer available for ${revertsRemoved.join(', ')}.`
        : '';
      setPruneStatus(
        (deleted > 0
          ? `Freed ${formatBytes(spaceReclaimed)} (${deleted} layer${deleted === 1 ? '' : 's'} removed).`
          : 'Nothing to prune — no dangling layers found.') + revertNote
      );
      if (deleted > 0) {
        onPruneComplete?.();
        setStatus((prev) => (prev ? { ...prev, danglingImages: { ...prev.danglingImages, count: 0 } } : prev));
      }
    } catch (err) {
      setPruneStatus(err.message || 'Prune failed');
    } finally {
      setPruning(false);
      setPruneCandidates([]);
    }
  }, [onPruneComplete, pruneSelection]);

  const handleUnpin = useCallback(
    async (ref) => {
      setUnpinningRef(ref);
      setPinnedError('');
      try {
        await unpin(ref);
        await loadPinned();
      } catch (err) {
        setPinnedError(err.message || 'Failed to unpin version');
      } finally {
        setUnpinningRef('');
      }
    },
    [loadPinned]
  );

  return (
    <div className="settings-page">
      <h2>Settings</h2>

      <section className="settings-section">
        <h3>Appearance</h3>
        <div className="settings-row">
          <div className="settings-row-label">
            <span>Theme</span>
            <span className="settings-row-desc">
              {theme === 'dark' ? 'Dark theme is active.' : 'Light theme is active.'}
            </span>
          </div>
          <button
            type="button"
            className="theme-switch"
            role="switch"
            aria-checked={theme === 'light'}
            aria-label="Toggle light/dark theme"
            onClick={toggle}
          >
            <span className="theme-switch-track">
              <span className="theme-switch-thumb" />
            </span>
            <span className="theme-switch-text">{theme === 'dark' ? 'Dark' : 'Light'}</span>
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3>Behaviour</h3>
        {settingsError && <p className="settings-error">{settingsError}</p>}
        <div className="settings-row">
          <div className="settings-row-label">
            <span>Default view</span>
            <span className="settings-row-desc">Which containers the dashboard shows first.</span>
          </div>
          <div className="filter-row">
            <button
              type="button"
              className={`chip${settings?.defaultFilter !== 'all' ? ' is-active' : ''}`}
              onClick={() => saveSetting({ defaultFilter: 'updates' }).catch(() => {})}
              disabled={!settings}
            >
              Updates only
            </button>
            <button
              type="button"
              className={`chip${settings?.defaultFilter === 'all' ? ' is-active' : ''}`}
              onClick={() => saveSetting({ defaultFilter: 'all' }).catch(() => {})}
              disabled={!settings}
            >
              All
            </button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <span>Check on open</span>
            <span className="settings-row-desc">
              Automatically check for updates when you open the app.
            </span>
          </div>
          <button
            type="button"
            className="theme-switch"
            role="switch"
            aria-checked={!!settings?.autoCheckOnOpen}
            aria-label="Toggle check on open"
            onClick={() => saveSetting({ autoCheckOnOpen: !settings?.autoCheckOnOpen }).catch(() => {})}
            disabled={!settings}
          >
            <span className="theme-switch-track">
              <span className="theme-switch-thumb" />
            </span>
            <span className="theme-switch-text">{settings?.autoCheckOnOpen ? 'On' : 'Off'}</span>
          </button>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <span>Newer version tags</span>
            <span className="settings-row-desc">
              For containers on a version tag (e.g. <code>postgres:16.3</code>), offer newer
              versions like 16.4 — and optionally the next major version.
            </span>
          </div>
          <select
            className="settings-input settings-select settings-time"
            value={settings?.tagUpdates || 'minor'}
            onChange={(e) => saveSetting({ tagUpdates: e.target.value }).catch(() => {})}
            disabled={!settings}
            aria-label="Newer version tags"
          >
            <option value="off">Off</option>
            <option value="minor">Same major</option>
            <option value="major">Include major</option>
          </select>
        </div>
      </section>

      <section className="settings-section">
        <h3>Background checks &amp; notifications</h3>
        <div className="settings-row">
          <div className="settings-row-label">
            <span>Background scan</span>
            <span className="settings-row-desc">
              Check for updates on a schedule, even when the app is closed. A scan missed while
              the server was off runs shortly after it starts.
              {settings?.backgroundCheckEnabled && status?.nextScanAt ? (
                <> Next scan {formatWhen(status.nextScanAt)}.</>
              ) : null}
            </span>
          </div>
          <button
            type="button"
            className="theme-switch"
            role="switch"
            aria-checked={!!settings?.backgroundCheckEnabled}
            aria-label="Toggle background checks"
            onClick={() =>
              saveSetting({ backgroundCheckEnabled: !settings?.backgroundCheckEnabled })
                .then(refreshStatus)
                .catch(() => {})
            }
            disabled={!settings}
          >
            <span className="theme-switch-track">
              <span className="theme-switch-thumb" />
            </span>
            <span className="theme-switch-text">{settings?.backgroundCheckEnabled ? 'On' : 'Off'}</span>
          </button>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <span>Schedule</span>
            <span className="settings-row-desc">Once a day at a set time, or every few hours.</span>
          </div>
          <select
            className="settings-input settings-select settings-time"
            value={settings?.scheduleMode || 'daily'}
            onChange={(e) => saveSetting({ scheduleMode: e.target.value }).then(refreshStatus).catch(() => {})}
            disabled={!settings || !settings?.backgroundCheckEnabled}
            aria-label="Scan schedule"
          >
            <option value="daily">Daily</option>
            <option value="interval">Every N hours</option>
          </select>
        </div>
        {settings?.scheduleMode === 'interval' ? (
          <div className="settings-row">
            <div className="settings-row-label">
              <span>Scan every</span>
              <span className="settings-row-desc">Hours between scans (1–168).</span>
            </div>
            <select
              className="settings-input settings-select settings-time"
              value={String(settings?.scheduleIntervalHours || 6)}
              onChange={(e) =>
                saveSetting({ scheduleIntervalHours: Number(e.target.value) }).then(refreshStatus).catch(() => {})
              }
              disabled={!settings || !settings?.backgroundCheckEnabled}
              aria-label="Hours between scans"
            >
              {[1, 2, 3, 4, 6, 8, 12, 24, 48, 168].map((h) => (
                <option key={h} value={String(h)}>
                  {h === 168 ? '1 week' : h === 48 ? '2 days' : `${h} hour${h === 1 ? '' : 's'}`}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="settings-row">
            <div className="settings-row-label">
              <span>Daily scan time</span>
              <span className="settings-row-desc">
                When the daily scan runs, on the <strong>server's clock</strong>
                {status?.timeZone ? (
                  <>
                    {' '}
                    — currently {status.serverLocalTime} {status.timeZone}. If that's off, set the
                    container's <code>TZ</code> (e.g. <code>TZ=Europe/London</code>).
                  </>
                ) : (
                  '.'
                )}
              </span>
            </div>
            <input
              type="time"
              className="settings-input settings-time"
              value={settings?.scheduledCheckTime || '09:00'}
              onChange={(e) => saveSetting({ scheduledCheckTime: e.target.value }).then(refreshStatus).catch(() => {})}
              disabled={!settings || !settings?.backgroundCheckEnabled}
            />
          </div>
        )}
        <div className="settings-row">
          <div className="settings-row-label">
            <span>Notify via</span>
            <span className="settings-row-desc">Where update notifications are sent.</span>
          </div>
          <select
            className="settings-input settings-select settings-time"
            value={settings?.notifyType || 'discord'}
            onChange={(e) => saveSetting({ notifyType: e.target.value }).catch(() => {})}
            disabled={!settings}
          >
            <option value="discord">Discord</option>
            <option value="ntfy">ntfy</option>
            <option value="gotify">Gotify</option>
            <option value="webhook">Webhook</option>
          </select>
        </div>
        <div className="settings-row settings-row-stack">
          <div className="settings-row-label">
            <span>{NOTIFY_META[settings?.notifyType || 'discord'].label}</span>
            <span className="settings-row-desc">
              {NOTIFY_META[settings?.notifyType || 'discord'].desc}
            </span>
          </div>
          <input
            type="url"
            className="settings-input"
            placeholder={NOTIFY_META[settings?.notifyType || 'discord'].placeholder}
            value={webhookDraft}
            onChange={(e) => setWebhookDraft(e.target.value)}
            onBlur={() => {
              if (settings && webhookDraft !== settings.discordWebhookUrl) {
                saveSetting({ discordWebhookUrl: webhookDraft }).catch(() => {});
              }
            }}
            disabled={!settings}
          />
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <span>Send notifications</span>
            <span className="settings-row-desc">Notify after a background scan when updates are found.</span>
          </div>
          <button
            type="button"
            className="theme-switch"
            role="switch"
            aria-checked={!!settings?.discordEnabled}
            aria-label="Toggle Discord notifications"
            onClick={() => saveSetting({ discordEnabled: !settings?.discordEnabled }).catch(() => {})}
            disabled={!settings}
          >
            <span className="theme-switch-track">
              <span className="theme-switch-thumb" />
            </span>
            <span className="theme-switch-text">{settings?.discordEnabled ? 'On' : 'Off'}</span>
          </button>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <span>Notify on failures</span>
            <span className="settings-row-desc">
              Also send a message when an update or revert fails, or comes up unhealthy.
            </span>
          </div>
          <button
            type="button"
            className="theme-switch"
            role="switch"
            aria-checked={!!settings?.notifyOnFailure}
            aria-label="Toggle failure notifications"
            onClick={() => saveSetting({ notifyOnFailure: !settings?.notifyOnFailure }).catch(() => {})}
            disabled={!settings || !settings?.discordEnabled}
          >
            <span className="theme-switch-track">
              <span className="theme-switch-thumb" />
            </span>
            <span className="theme-switch-text">{settings?.notifyOnFailure ? 'On' : 'Off'}</span>
          </button>
        </div>
        <div className="settings-row">
          <button
            type="button"
            className="btn btn-sm"
            onClick={runTest}
            disabled={testing || !webhookDraft}
          >
            {testing && <span className="spinner" aria-hidden="true" />}
            Send test message
          </button>
          {testStatus && <span className="settings-test-status">{testStatus}</span>}
        </div>
      </section>

      <section className="settings-section">
        <h3>Pinned versions</h3>
        {pinnedLoading && (
          <div className="dashboard-list" aria-busy="true" aria-label="Loading pinned versions">
            <div className="skeleton-card" style={{ height: 52 }} />
            <div className="skeleton-card" style={{ height: 52 }} />
          </div>
        )}

        {!pinnedLoading && pinnedError && (
          <div className="error-state">
            <p>{pinnedError}</p>
            <button type="button" className="btn btn-primary" onClick={loadPinned}>
              Retry
            </button>
          </div>
        )}

        {!pinnedLoading && !pinnedError && pinned.length === 0 && (
          <div className="empty-state">
            <p>No pinned versions.</p>
          </div>
        )}

        {!pinnedLoading && !pinnedError && pinned.length > 0 && (
          <ul className="pinned-list">
            {pinned.map((ref) => (
              <li key={ref} className="pinned-row">
                <span className="pinned-ref truncate" title={ref}>
                  {ref}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => handleUnpin(ref)}
                  disabled={unpinningRef === ref}
                >
                  {unpinningRef === ref && <span className="spinner" aria-hidden="true" />}
                  Unpin
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings-section">
        <h3>
          Maintenance
          {Boolean(status?.danglingImages?.count) && <span className="badge-dot" aria-hidden="true" />}
        </h3>
        <div className="settings-row">
          <div className="settings-row-label">
            <span>Prune unused image layers</span>
            <span className="settings-row-desc">
              Removes dangling image layers left behind after updates. Safe — only untagged
              layers that nothing uses.
            </span>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={handlePruneClick}
            disabled={pruning || pruneSummaryLoading}
          >
            {(pruning || pruneSummaryLoading) && <span className="spinner" aria-hidden="true" />}
            Prune now
          </button>
        </div>
        {pruneStatus && (
          <div className="settings-row">
            <span className="settings-test-status">{pruneStatus}</span>
          </div>
        )}
        {confirmPrune && (
          <ConfirmDialog
            title="Prune unused image layers?"
            dialogClassName="confirm-dialog--wide"
            confirmLabel={
              pruneSelection.length
                ? `Prune ${pruneSelection.length} (~${formatBytes(
                    pruneSelection.reduce((sum, img) => sum + (img.size || 0), 0)
                  )})`
                : 'Prune'
            }
            confirming={pruning}
            confirmDisabled={pruneSelection.length === 0}
            onConfirm={handlePrune}
            onCancel={() => {
              setConfirmPrune(false);
              setPruneCandidates([]);
            }}
          >
            <p className="confirm-message">
              Leftover layers from image updates. Untick a row to keep it — it'll reappear here
              next time. Tagged images and anything in use are never touched. Sizes are what
              removing each one should free (layers shared with images you still use aren't
              counted).
            </p>
            {pruneCandidates.some((img) => img.fromContainer) && (
              <p className="confirm-message prune-revert-warning">
                Rows named after a container are its previous version, kept so you can revert its
                last update. They're left out unless you tick them — pruning one removes that
                container's Revert option.
              </p>
            )}
            {pruneSelection.length === 0 && (
              <p className="prune-empty">Nothing selected — nothing will be pruned.</p>
            )}
            {pruneCandidates.length > 0 && (
              <div className="prune-table-scroll">
                <table className="prune-table">
                  <thead>
                    <tr>
                      <th>Layer</th>
                      <th className="prune-size">Size</th>
                      <th className="prune-created">Created</th>
                      <th aria-label="Include" />
                    </tr>
                  </thead>
                  <tbody>
                    {pruneCandidates.map((img) => (
                      <tr key={img.id} className={pruneExcluded.has(img.id) ? 'is-excluded' : undefined}>
                        <td>
                          <span className="prune-source">
                            {img.fromContainer || 'Untracked source'}
                          </span>
                          <span className="prune-source-id">{img.id}</span>
                        </td>
                        <td
                          className="prune-size"
                          title={
                            img.fullSize && img.fullSize !== img.size
                              ? `Whole image is ${formatBytes(img.fullSize)}; the rest is shared with other images and stays.`
                              : undefined
                          }
                        >
                          {formatBytes(img.size || 0)}
                        </td>
                        <td className="prune-created">{formatAge(img.created)}</td>
                        <td className="prune-remove-cell">
                          <input
                            type="checkbox"
                            className="prune-row-check"
                            checked={!pruneExcluded.has(img.id)}
                            onChange={() => togglePruneImage(img.id)}
                            disabled={pruning}
                            aria-label={`Prune ${img.fromContainer || img.id}`}
                            title={pruneExcluded.has(img.id) ? 'Include in prune' : 'Keep this layer'}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ConfirmDialog>
        )}
      </section>

      <section className="settings-section">
        <h3>Account &amp; data</h3>
        <div className="settings-row">
          <div className="settings-row-label">
            <span>Sign out everywhere</span>
            <span className="settings-row-desc">
              Signs out every other browser and device. This one stays signed in.
            </span>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => setConfirmLogoutAll(true)} disabled={accountBusy}>
            Sign out others
          </button>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <span>Backup</span>
            <span className="settings-row-desc">
              Settings, pinned versions and update history as a file — for moving DockPull to a
              new host. It includes your notification URL, so keep it private.
            </span>
          </div>
          <a className="btn btn-sm" href={`${API_BASE}/backup`} download>
            Download
          </a>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">
            <span>Restore</span>
            <span className="settings-row-desc">
              Load a backup file. Replaces these settings; history is only restored into an empty
              history.
            </span>
          </div>
          <label className={`btn btn-sm${accountBusy ? ' is-disabled' : ''}`}>
            Choose file…
            <input
              type="file"
              accept="application/json,.json"
              className="visually-hidden"
              onChange={handleRestoreFile}
              disabled={accountBusy}
            />
          </label>
        </div>
        {accountStatus && <p className="settings-test-status">{accountStatus}</p>}
        {confirmLogoutAll && (
          <ConfirmDialog
            title="Sign out everywhere else?"
            message="Every other browser and device signed in to DockPull will need to log in again."
            confirmLabel="Sign out others"
            onConfirm={handleLogoutAll}
            onCancel={() => setConfirmLogoutAll(false)}
          />
        )}
        {pendingRestore && (
          <ConfirmDialog
            title="Restore this backup?"
            message={`Backup from ${pendingRestore.exportedAt ? new Date(pendingRestore.exportedAt).toLocaleString() : 'an unknown date'}${
              pendingRestore.appVersion ? ` (DockPull ${pendingRestore.appVersion})` : ''
            }: ${(pendingRestore.pinned || []).length} pinned, ${(pendingRestore.history || []).length} history entries. Your current settings will be replaced.`}
            confirmLabel="Restore"
            onConfirm={handleRestoreConfirm}
            onCancel={() => setPendingRestore(null)}
          />
        )}
      </section>

      <section className="settings-section">
        <h3>About</h3>
        <p className="about-app-name">
          DockPull{status?.version ? <span className="about-version"> v{status.version}</span> : null}
        </p>
        <p className="settings-row-desc">
          A small dashboard for checking your containers' images for updates and applying
          them by hand.
        </p>
        <p className="settings-row-desc">
          Updates are always manual — this app never pulls or recreates a container on its
          own; it only tells you an update is available.
        </p>
        <p className="health-indicator">
          <span
            className={`health-dot${health === true ? ' is-ok' : health === false ? ' is-down' : ''}`}
            aria-hidden="true"
          />
          {health === null ? 'Server: checking…' : health ? 'Server: OK' : 'Server: unreachable'}
        </p>
      </section>
    </div>
  );
}
