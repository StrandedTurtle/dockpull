import React, { useCallback, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { getMe } from './api.js';
import AuthPage from './AuthPage.jsx';
import Dashboard from './Dashboard.jsx';
import Header from './components/Header.jsx';
import HistoryStub from './pages/HistoryStub.jsx';
import SettingsStub from './pages/SettingsStub.jsx';

export default function App() {
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

  const handleAuthed = useCallback(() => {
    checkSession();
  }, [checkSession]);

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
          <Route path="/history" element={<HistoryStub />} />
          <Route path="/settings" element={<SettingsStub />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
