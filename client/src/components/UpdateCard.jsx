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

const PinIcon = ({ filled }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} aria-hidden="true">
    <path
      d="M12 2l1.5 5.5L19 9l-4.5 3.5L16 18l-4-3-4 3 1.5-5.5L5 9l5.5-1.5L12 2z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * A single container's card: identity, digests, pin toggle, update button,
 * and an expandable live log area for the in-flight (or most recent) update.
 *
 * props:
 *  - container: item shape from GET /api/containers
 *  - onSettled(name) — called once an update for this container finishes
 *    (success, failure, or stream error); used by the dashboard to re-fetch
 *    the container list and clear in-flight bookkeeping.
 *  - onPinChange() — called after a successful pin/unpin so the dashboard can refresh
 *  - registerRunner(name, runFn) — gives the parent a handle to trigger this
 *    card's update programmatically (used by "Update all"); pass null/no-op
 *    if not needed.
 */
export default function UpdateCard({ container, onSettled, onPinChange, registerRunner }) {
  const {
    name,
    project,
    service,
    image,
    currentDigest,
    availableVersion,
    availableDigest,
    updateAvailable,
    pinned,
  } = container;

  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState('');

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
    setPinError('');
    try {
      if (pinned) {
        await unpin(image);
      } else {
        await pin(image);
      }
      onPinChange();
    } catch (err) {
      setPinError(err.message || 'Failed to update pin');
    } finally {
      setPinBusy(false);
    }
  }, [pinned, image, onPinChange]);

  const showUpdateAvailable = updateAvailable && !pinned;

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

      {pinError && <StatusMessage type="error" message={pinError} />}
      {startError && <StatusMessage type="error" message={startError} />}
      <StatusMessage type={status.type} message={status.message} />

      <div className="card-actions">
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
