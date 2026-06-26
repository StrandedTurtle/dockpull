import React, { useCallback, useEffect, useState } from 'react';
import { pin, unpin } from '../api.js';
import { useUpdateRunner } from '../hooks/useUpdateRunner.js';
import StatusMessage from './StatusMessage.jsx';
import StreamLog from './StreamLog.jsx';

function shortDigest(digest) {
  if (!digest) return '—';
  const clean = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest;
  return clean.slice(0, 12);
}

// Prefer a human version (OCI version label), then the tag, then a short
// digest as a last resort, so the card shows "1.27.3" / "latest" rather than a
// meaningless hash.
function displayVersion({ currentVersion, tag, currentDigest }) {
  if (currentVersion) return currentVersion;
  if (tag) return tag;
  return shortDigest(currentDigest);
}

// Build a "Changelog"/"Source" link from the image's OCI source label. GitHub
// repos get pointed at their releases page (best place for a changelog).
function sourceLink(sourceUrl) {
  if (!sourceUrl) return null;
  const isGitHub = /(^|\/\/|\.)github\.com\//i.test(sourceUrl);
  return {
    href: isGitHub ? `${sourceUrl.replace(/\/$/, '')}/releases` : sourceUrl,
    label: isGitHub ? 'Changelog' : 'Source',
  };
}

// A pushpin / thumbtack icon (filled when the version is pinned).
const PinIcon = ({ filled }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} aria-hidden="true">
    <path
      d="M9 3h6l-1 5 3 3v2H7v-2l3-3-1-5z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path d="M12 13v8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

const ExternalIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M14 4h6v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M20 4l-9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path
      d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * A single container's card: identity, version, source/changelog link, pin +
 * hide controls, update button, and an expandable live log for the in-flight
 * (or most recent) update.
 *
 * props:
 *  - container: item shape from GET /api/containers
 *  - onSettled(name) — called once an update for this container finishes
 *  - onPinChange() — called after a pin/unpin so the dashboard can refresh
 *  - registerRunner(name, runFn) — handle for "Update all"
 */
export default function UpdateCard({ container, onSettled, onPinChange, registerRunner }) {
  const { name, project, service, image, currentDigest, availableVersion, availableDigest, updateAvailable, pinned, sourceUrl } =
    container;

  const [pinBusy, setPinBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  const { run, busy, startError, status, lines } = useUpdateRunner(name, onSettled);

  useEffect(() => {
    if (registerRunner) registerRunner(name, run);
    return () => {
      if (registerRunner) registerRunner(name, null);
    };
  }, [registerRunner, name, run]);

  const handleUpdateClick = useCallback(() => {
    if (busy) return;
    run();
  }, [busy, run]);

  const togglePin = useCallback(async () => {
    setPinBusy(true);
    setActionError('');
    try {
      if (pinned) {
        await unpin(image);
      } else {
        await pin(image);
      }
      if (onPinChange) onPinChange();
    } catch (err) {
      setActionError(err.message || 'Failed to update pin');
    } finally {
      setPinBusy(false);
    }
  }, [pinned, image, onPinChange]);

  const showUpdateAvailable = updateAvailable && !pinned;
  const link = sourceLink(sourceUrl);

  return (
    <div className={`update-card${showUpdateAvailable ? ' has-update' : ''}`}>
      <div className="card-top">
        <div className="card-identity">
          <div className="card-name truncate" title={name}>
            {name}
          </div>
          <div className="card-image truncate" title={image}>
            {image}
          </div>
          <div className="card-meta-row">
            {service && (
              <span className="pill" title={`${project || ''}/${service || ''}`}>
                {service}
              </span>
            )}
            {pinned && <span className="pill pill-pinned">Version pinned</span>}
          </div>
        </div>
        <button
          type="button"
          className={`pin-toggle${pinned ? ' is-pinned' : ''}`}
          onClick={togglePin}
          disabled={pinBusy}
          aria-pressed={pinned}
          aria-label={pinned ? 'Unpin version' : 'Pin version (hold current)'}
          title={pinned ? 'Unpin version' : 'Pin version (hold current)'}
        >
          <PinIcon filled={pinned} />
        </button>
      </div>

      <div className="card-versions">
        <div className="version-row">
          <span className="version-label">Running</span>
          <span className="version-value" title={currentDigest || ''}>
            {displayVersion(container)}
          </span>
        </div>
        {showUpdateAvailable && (
          <div className="version-row">
            <span className="version-label">Available</span>
            <span className="version-value is-available" title={availableDigest || ''}>
              {availableVersion || 'newer image'}
            </span>
          </div>
        )}
      </div>

      {actionError && <StatusMessage type="error" message={actionError} />}
      {startError && <StatusMessage type="error" message={startError} />}
      <StatusMessage type={status.type} message={status.message} />

      <div className="card-actions">
        <div className="card-actions-left">
          {link && (
            <a className="card-link" href={link.href} target="_blank" rel="noopener noreferrer">
              {link.label}
              <ExternalIcon />
            </a>
          )}
        </div>
        <button
          type="button"
          className={`btn update-btn${showUpdateAvailable ? ' btn-primary' : ''}`}
          onClick={handleUpdateClick}
          disabled={busy}
        >
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy ? 'Updating…' : 'Update'}
        </button>
      </div>

      <StreamLog lines={lines} />
    </div>
  );
}
