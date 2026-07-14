import React, { useCallback, useEffect, useState } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { getMe, setUnauthorizedHandler } from './api.js';
import { useTheme } from './hooks/useTheme.js';
import AuthPage from './AuthPage.jsx';
import Dashboard from './Dashboard.jsx';
import Header from './components/Header.jsx';
import BottomNav from './components/BottomNav.jsx';
import HistoryPage from './pages/HistoryPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';

export default function App() {
  // Initialized at the app level so `data-theme` is set on <html> from the
  // first paint, before any route-specific component mounts.
  useTheme();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  const checkSession = useCallback(async () => {
    try {
      const data = await getMe();
      setAuthenticated(!!(data && data.authenticated));
    } catch {
      setAuthenticated(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    checkSession().finally(() => setLoading(false));
  }, [checkSession]);

  // If any authenticated request 401s (session expired mid-use), drop straight
  // back to the sign-in gate instead of stranding the user on a broken page.
  useEffect(() => {
    setUnauthorizedHandler(() => setAuthenticated(false));
    return () => setUnauthorizedHandler(null);
  }, []);

  // Installed-PWA nicety: mirror the pending-update count onto the app icon
  // (Badging API — a no-op on browsers/platforms without it).
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('setAppBadge' in navigator)) return;
    if (authenticated && pendingCount > 0) {
      navigator.setAppBadge(pendingCount).catch(() => {});
    } else {
      navigator.clearAppBadge().catch(() => {});
    }
  }, [pendingCount, authenticated]);

  const handleAuthed = useCallback(() => {
    checkSession();
    navigate('/'); // land on the dashboard after signing in
  }, [checkSession, navigate]);

  const handleLoggedOut = useCallback(() => {
    setAuthenticated(false);
  }, []);

  if (loading) {
    return (
      <div className="spinner-page" role="status" aria-label="Loading">
        <span className="spinner" />
      </div>
    );
  }

  if (!authenticated) {
    return <AuthPage onAuthed={handleAuthed} />;
  }

  return (
    <div className="app-shell">
      <Header pendingCount={pendingCount} onLoggedOut={handleLoggedOut} />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Dashboard onPendingCountChange={setPendingCount} />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <BottomNav />
    </div>
  );
}
