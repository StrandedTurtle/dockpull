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
  const { name, project, service, image, currentDigest, availableDigest, updateAvailable, pinned } =
    container;

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
          <div className="card-meta-row">
            {(project || service) && (
              <span className="pill" title={`${project || ''}/${service || ''}`}>
                {project}
                {project && service ? '/' : ''}
                {service}
              </span>
            )}
            {pinned && <span className="pill pill-pinned">Pinned</span>}
          </div>
        </div>
        <button
          type="button"
          className={`pin-toggle${pinned ? ' is-pinned' : ''}`}
          onClick={togglePin}
          disabled={pinBusy}
          aria-pressed={pinned}
          aria-label={pinned ? 'Unpin image' : 'Pin image'}
          title={pinned ? 'Unpin image' : 'Pin image'}
        >
          <PinIcon filled={pinned} />
        </button>
      </div>

      <div className="card-digests">
        <div className="digest-row">
          <span className="digest-label">Current</span>
          <span className="digest-value" title={currentDigest || ''}>
            {shortDigest(currentDigest)}
          </span>
        </div>
        <div className="digest-row">
          <span className="digest-label">Available</span>
          <span
            className={`digest-value${updateAvailable ? ' is-available' : ''}`}
            title={availableDigest || ''}
          >
            {updateAvailable ? shortDigest(availableDigest) : '—'}
          </span>
        </div>
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
