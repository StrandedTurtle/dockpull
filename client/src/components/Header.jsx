import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { logout } from '../api.js';

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

/**
 * Sticky top bar. `pendingCount` is the number of containers with an
 * available, non-pinned update (same count used on the dashboard badge).
 * `onLoggedOut` is called after the server session is cleared so App can
 * flip back to the AuthPage.
 */
export default function Header({ pendingCount = 0, onLoggedOut }) {
  const [loggingOut, setLoggingOut] = useState(false);

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
      <div className="header-actions">
        {/* WP5: theme toggle goes here (light/dark switch reading/writing
            data-theme on <html>, backed by styles/themes.css). */}
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
