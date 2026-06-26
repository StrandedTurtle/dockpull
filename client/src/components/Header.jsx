import React, { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { logout } from '../api.js';
import { useTheme } from '../hooks/useTheme.js';

const LogoutIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const SunIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" />
    <path
      d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);

const MoonIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Sticky top bar. `pendingCount` is the number of containers with an
 * available, non-pinned update (same count used on the dashboard badge).
 * `onLoggedOut` is called after the server session is cleared so App can
 * flip back to the AuthPage.
 */
export default function Header({ pendingCount = 0, onLoggedOut }) {
  const [loggingOut, setLoggingOut] = useState(false);
  const { theme, toggle } = useTheme();

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      // Even if the request fails, drop the client back to the auth gate —
      // getMe() on next load will reflect the true session state.
    } finally {
      setLoggingOut(false);
      onLoggedOut();
    }
  };

  return (
    <header className="app-header">
      <Link to="/" className="title-link">
        <span>Diun Updater</span>
        {pendingCount > 0 && <span className="badge">{pendingCount}</span>}
      </Link>
      <nav className="header-nav" aria-label="Primary">
        <NavLink to="/" end className={({ isActive }) => `header-nav-link${isActive ? ' is-active' : ''}`}>
          Updates
        </NavLink>
        <NavLink to="/history" className={({ isActive }) => `header-nav-link${isActive ? ' is-active' : ''}`}>
          History
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => `header-nav-link${isActive ? ' is-active' : ''}`}>
          Settings
        </NavLink>
      </nav>
      <div className="header-actions">
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={toggle}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={handleLogout}
          disabled={loggingOut}
          aria-label="Log out"
          title="Log out"
        >
          {loggingOut ? <span className="spinner" aria-hidden="true" /> : <LogoutIcon />}
        </button>
      </div>
    </header>
  );
}
