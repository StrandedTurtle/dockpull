import React, { useCallback, useEffect, useState } from 'react';
import {
  get,
  getPinned,
  unpin,
  getSettings,
  updateSettings,
} from '../api.js';
import { useTheme } from '../hooks/useTheme.js';

export default function SettingsPage() {
  const { theme, toggle } = useTheme();

  const [pinned, setPinned] = useState([]);
  const [pinnedLoading, setPinnedLoading] = useState(true);
  const [pinnedError, setPinnedError] = useState('');
  const [unpinningRef, setUnpinningRef] = useState('');

  const [settings, setSettings] = useState(null);
  const [settingsError, setSettingsError] = useState('');

  const [health, setHealth] = useState(null); // null = unknown, true/false once checked

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

  useEffect(() => {
    get('/health')
      .then((data) => setHealth(!!(data && data.ok)))
      .catch(() => setHealth(false));
  }, []);

  const saveSetting = useCallback(
    async (patch) => {
      // optimistic
      setSettings((prev) => ({ ...prev, ...patch }));
      setSettingsError('');
      try {
        const updated = await updateSettings(patch);
        setSettings(updated);
      } catch (err) {
        setSettingsError(err.message || 'Failed to save settings');
      }
    },
    []
  );

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
              onClick={() => saveSetting({ defaultFilter: 'updates' })}
              disabled={!settings}
            >
              Updates only
            </button>
            <button
              type="button"
              className={`chip${settings?.defaultFilter === 'all' ? ' is-active' : ''}`}
              onClick={() => saveSetting({ defaultFilter: 'all' })}
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
            onClick={() => saveSetting({ autoCheckOnOpen: !settings?.autoCheckOnOpen })}
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
        <h3>About</h3>
        <p className="about-app-name">Diun Updater</p>
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
