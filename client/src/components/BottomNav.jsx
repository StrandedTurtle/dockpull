import React from 'react';
import { NavLink } from 'react-router-dom';

const UpdatesIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3" y="4" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
    <path d="M3 9h18" stroke="currentColor" strokeWidth="2" />
  </svg>
);

const HistoryIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="13" r="8" stroke="currentColor" strokeWidth="2" />
    <path
      d="M12 9v4l3 2"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M9 2h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const SettingsIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
    <path
      d="M19.4 13a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-.33-1.82l-1-1a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 01-1.82-.33l-.06-.06a1.65 1.65 0 01-.33-1.82V5a1.65 1.65 0 00-1.65-1.65h-1.4A1.65 1.65 0 009.7 5v.1a1.65 1.65 0 01-.33 1.82 1.65 1.65 0 01-1.82.33l-.06-.06a1.65 1.65 0 00-1.82.33l-1 1a1.65 1.65 0 00-.33 1.82 1.65 1.65 0 01.33 1.82l-.06.06a1.65 1.65 0 00-.33 1.82l1 1a1.65 1.65 0 001.82.33 1.65 1.65 0 011.82.33l.06.06a1.65 1.65 0 01.33 1.82V19A1.65 1.65 0 0011 20.65h1.4A1.65 1.65 0 0014 19v-.1a1.65 1.65 0 01.33-1.82 1.65 1.65 0 011.82-.33l.06.06a1.65 1.65 0 001.82-.33l1-1a1.65 1.65 0 00.33-1.82z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const TABS = [
  { to: '/', label: 'Updates', Icon: UpdatesIcon, end: true },
  { to: '/history', label: 'History', Icon: HistoryIcon, end: false },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon, end: false },
];

/**
 * Fixed bottom tab bar, mobile-only (hidden at >=768px via CSS in app.css).
 */
export default function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="Primary">
      {TABS.map(({ to, label, Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) => `bottom-nav-tab${isActive ? ' is-active' : ''}`}
        >
          <Icon />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
