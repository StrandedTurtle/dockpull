import React, { useState } from 'react';

function shortDigest(digest) {
  if (!digest) return '—';
  const clean = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest;
  return clean.slice(0, 12);
}

// `created_at` is a UTC "YYYY-MM-DD HH:MM:SS" string (no timezone suffix),
// so it must be parsed as UTC explicitly — new Date() on that literal string
// would otherwise be interpreted as local time in most browsers.
function parseUtc(value) {
  if (!value) return null;
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function relativeTime(value) {
  const date = parseUtc(value);
  if (!date) return '';
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.round(months / 12);
  return `${years}y ago`;
}

/**
 * A single update_history row. Collapsed: container name, image, status
 * badge, short old->new digests, relative timestamp. Expanded (on click or
 * Enter/Space): full digests, full message, absolute timestamp.
 *
 * props: { entry } shaped per GET /api/history (see API_CONTRACT.md).
 */
export default function HistoryRow({ entry }) {
  const [expanded, setExpanded] = useState(false);
  const { container_name, image, old_digest, new_digest, status, message, created_at } = entry;

  const isSuccess = status === 'success';
  const toggle = () => setExpanded((value) => !value);
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  };

  const date = parseUtc(created_at);

  return (
    <div
      className={`history-row${expanded ? ' is-expanded' : ''}`}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={toggle}
      onKeyDown={handleKeyDown}
    >
      <div className="history-row-top">
        <div className="history-row-identity">
          <div className="history-row-name truncate" title={container_name}>
            {container_name}
          </div>
          <div className="history-row-image truncate" title={image}>
            {image}
          </div>
        </div>
        <span className={`pill status-pill ${isSuccess ? 'status-pill-success' : 'status-pill-error'}`}>
          {isSuccess ? 'Success' : 'Failure'}
        </span>
      </div>

      <div className="history-row-meta">
        <span className="history-row-digests">
          <span className="digest-value">{shortDigest(old_digest)}</span>
          <span className="digest-arrow" aria-hidden="true">
            →
          </span>
          <span className="digest-value">{shortDigest(new_digest)}</span>
        </span>
        <span className="history-row-time" title={date ? date.toISOString() : ''}>
          {relativeTime(created_at)}
        </span>
      </div>

      {expanded && (
        <div className="history-row-details">
          <div className="digest-row">
            <span className="digest-label">Old digest</span>
            <span className="digest-value digest-value-full">{old_digest || '—'}</span>
          </div>
          <div className="digest-row">
            <span className="digest-label">New digest</span>
            <span className="digest-value digest-value-full">{new_digest || '—'}</span>
          </div>
          {message && <p className="history-row-message">{message}</p>}
          {date && <p className="history-row-absolute-time">{date.toLocaleString()}</p>}
        </div>
      )}
    </div>
  );
}
