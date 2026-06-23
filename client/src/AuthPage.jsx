import React, { useState } from 'react';
import { login } from './api.js';

/**
 * Single-password sign-in gate. No email/signup/forgot-password — the
 * server uses one shared ADMIN_PASSWORD (see API_CONTRACT.md).
 */
export default function AuthPage({ onAuthed }) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting || !password) return;
    setSubmitting(true);
    setError('');
    try {
      await login(password);
      onAuthed();
    } catch {
      setError('Incorrect password');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Diun Updater</h1>
        <p className="subtitle">Sign in to manage your containers</p>
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
          </div>
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" className="btn btn-primary btn-block" disabled={submitting || !password}>
            {submitting && <span className="spinner" aria-hidden="true" />}
            Sign In
          </button>
        </form>
      </div>
    </div>
  );
}
