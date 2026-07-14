import React, { useCallback, useEffect, useState } from 'react';
import { get, getPinned, unpin, getSettings, updateSettings, testNotify, getStatus, pruneImages } from '../api.js';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { useTheme } from '../hooks/useTheme.js';

// Human-readable byte count: whole bytes below 1 KB, one decimal above.
function formatBytes(n) {
  if (!Number.isFinite(n) || n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n;
  let i = -1;
  do {
    value /= 1024;
    i += 1;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(1)} ${units[i]}`;
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

export default function SettingsPage() {
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

  useEffect(() => {
    getStatus()
      .then((s) => setStatus(s || null))
      .catch(() => {});
  }, []);

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

  const handlePrune = useCallback(async () => {
    setConfirmPrune(false);
    setPruning(true);
    setPruneStatus('');
    try {
      const { deleted = 0, spaceReclaimed = 0 } = (await pruneImages()) || {};
      setPruneStatus(
        deleted > 0
          ? `Freed ${formatBytes(spaceReclaimed)} (${deleted} layer${deleted === 1 ? '' : 's'} removed).`
          : 'Nothing to prune — no dangling layers found.'
      );
    } catch (err) {
      setPruneStatus(err.message || 'Prune failed');
    } finally {
      setPruning(false);
    }
  }, []);

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
      </section>

      <section className="settings-section">
        <h3>Background checks &amp; notifications</h3>
        <div className="settings-row">
          <div className="settings-row-label">
            <span>Daily scan</span>
            <span className="settings-row-desc">
              Run a scan once a day even when the app is closed.
            </span>
          </div>
          <button
            type="button"
            className="theme-switch"
            role="switch"
            aria-checked={!!settings?.backgroundCheckEnabled}
            aria-label="Toggle background checks"
            onClick={() =>
              saveSetting({ backgroundCheckEnabled: !settings?.backgroundCheckEnabled }).catch(() => {})
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
            onChange={(e) => saveSetting({ scheduledCheckTime: e.target.value }).catch(() => {})}
            disabled={!settings || !settings?.backgroundCheckEnabled}
          />
        </div>
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
            <span className="settings-row-desc">Notify on the daily scan when updates are found.</span>
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
        <h3>Maintenance</h3>
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
            onClick={() => setConfirmPrune(true)}
            disabled={pruning}
          >
            {pruning && <span className="spinner" aria-hidden="true" />}
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
            message="This removes dangling image layers left behind after updates. Tagged images and anything in use are never touched."
            confirmLabel="Prune"
            confirming={pruning}
            onConfirm={handlePrune}
            onCancel={() => setConfirmPrune(false)}
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
