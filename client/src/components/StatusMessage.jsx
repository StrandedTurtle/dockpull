import React, { useEffect, useState } from 'react';

const ICONS = {
  success: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 6L9 17l-5-5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  error: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M18 6L6 18M6 6l12 12"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  pending: (
    <span className="spinner" aria-hidden="true" style={{ width: '0.9em', height: '0.9em' }} />
  ),
};

/**
 * Small inline status line used for update results.
 * props: { type: 'success'|'error'|'pending'|'', message }
 * Success auto-fades after ~3s; error persists until replaced/cleared.
 */
export default function StatusMessage({ type, message }) {
  const [fading, setFading] = useState(false);

  useEffect(() => {
    setFading(false);
    if (type !== 'success') return undefined;
    const fadeTimer = setTimeout(() => setFading(true), 3000);
    return () => clearTimeout(fadeTimer);
  }, [type, message]);

  if (!type || !message) return null;

  return (
    <div
      className={`status-message ${type}${fading ? ' fade-out' : ''}`}
      role={type === 'error' ? 'alert' : 'status'}
    >
      {ICONS[type]}
      <span>{message}</span>
    </div>
  );
}
