import React, { useCallback, useEffect, useState } from 'react';
import { pin, unpin, getChangelog } from '../api.js';
import { useUpdateRunner } from '../hooks/useUpdateRunner.js';
import StatusMessage from './StatusMessage.jsx';
import StreamLog from './StreamLog.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';

function shortDigest(digest) {
  if (!digest) return '—';
  const clean = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest;
  return clean.slice(0, 12);
}

// Channel/branch words and shas aren't real versions — showing them produces
// misleading "main → main" cards. Mirrors server/src/version.js.
const VERSION_STOPWORDS = new Set([
  'latest', 'edge', 'stable', 'nightly', 'rolling', 'dev', 'devel', 'develop',
  'development', 'main', 'master', 'head', 'release', 'releases', 'snapshot',
  'canary', 'prod', 'production', 'current', 'beta', 'alpha', 'rc',
]);
function isMeaningfulVersion(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return false;
  if (VERSION_STOPWORDS.has(s.toLowerCase())) return false;
  if (/^sha-?256[:-]/i.test(s)) return false;
  if (/^[0-9a-f]{7,64}$/i.test(s)) return false;
  return true;
}

// Prefer a real version (OCI version label), then a meaningful tag, then a
// short digest as a last resort, so the card shows "1.27.3" rather than a
// junk channel name like "main" or a meaningless hash.
function displayVersion({ currentVersion, tag, currentDigest }) {
  if (isMeaningfulVersion(currentVersion)) return currentVersion;
  if (isMeaningfulVersion(tag)) return tag;
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

// Renders a resolved changelog payload (GitHub release notes, a link-out, or
// nothing). Release bodies render as plain text (React escapes — no XSS).
function ChangelogContent({ data }) {
  if (data.type === 'github') {
    if (!data.releases.length) {
      return (
        <p className="changelog-empty">
          No newer release notes found.{' '}
          <a href={data.releasesUrl} target="_blank" rel="noopener noreferrer">
            View releases
          </a>
        </p>
      );
    }
    return (
      <div className="changelog-releases">
        {data.releases.map((r) => (
          <div className="changelog-release" key={`${r.tag}-${r.url}`}>
            <div className="changelog-release-head">
              <a href={r.url} target="_blank" rel="noopener noreferrer">
                {r.name || r.tag}
              </a>
              {r.publishedAt && (
                <span className="changelog-date">
                  {new Date(r.publishedAt).toLocaleDateString()}
                </span>
              )}
            </div>
            {r.body && <pre className="changelog-body">{r.body}</pre>}
          </div>
        ))}
        <a className="card-link" href={data.releasesUrl} target="_blank" rel="noopener noreferrer">
          All releases
          <ExternalIcon />
        </a>
      </div>
    );
  }
  if (data.type === 'link') {
    return (
      <p className="changelog-empty">
        {data.note ? `${data.note} ` : ''}
        <a href={data.url} target="_blank" rel="noopener noreferrer">
          {data.label || 'Open'}
        </a>
      </p>
    );
  }
  return <p className="changelog-empty">No changelog source available for this image.</p>;
}

/**
 * A single container's card: identity, version, source/changelog link, pin
 * control, update button, an expandable "What's changed" panel, and an
 * expandable live log for the in-flight (or most recent) update.
 *
 * props:
 *  - container: item shape from GET /api/containers
 *  - onSettled(name) — called once an update for this container finishes
 *  - onPinChange() — called after a pin/unpin so the dashboard can refresh
 *  - registerRunner(name, runFn) — handle for "Update all"
 */
export default function UpdateCard({ container, onSettled, onPinChange, registerRunner }) {
  const { name, project, service, image, currentDigest, availableVersion, availableDigest, updateAvailable, pinned, sourceUrl, canRevert, rollbackVersion, checkError, state } =
    container;

  const [pinBusy, setPinBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [confirmRevert, setConfirmRevert] = useState(false);

  const [clOpen, setClOpen] = useState(false);
  const [clLoading, setClLoading] = useState(false);
  const [clData, setClData] = useState(null);
  const [clError, setClError] = useState('');

  const { run, revert, busy, startError, status, lines } = useUpdateRunner(name, onSettled);

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

  const handleRevert = useCallback(() => {
    setConfirmRevert(false);
    if (busy) return;
    revert();
  }, [busy, revert]);

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

  const toggleChangelog = useCallback(async () => {
    const next = !clOpen;
    setClOpen(next);
    if (next && !clData && !clLoading) {
      setClLoading(true);
      setClError('');
      try {
        const d = await getChangelog(name);
        setClData(d);
      } catch (err) {
        setClError(err.message || 'Failed to load changelog');
      } finally {
        setClLoading(false);
      }
    }
  }, [clOpen, clData, clLoading, name]);

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
            {state && state !== 'running' && (
              <span className="pill pill-state" title={`Container is ${state} — updating it will start it`}>
                {state}
              </span>
            )}
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
              {isMeaningfulVersion(availableVersion) ? availableVersion : 'newer image'}
            </span>
          </div>
        )}
      </div>

      {checkError && (
        <p className="card-check-error" title={checkError}>
          ⚠ Couldn't check for updates (e.g. private registry or rate limit).
        </p>
      )}
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
          {link && (
            <button type="button" className="btn-ghost" onClick={toggleChangelog} aria-expanded={clOpen}>
              {clOpen ? 'Hide changes' : showUpdateAvailable ? "What's changed" : 'Release notes'}
            </button>
          )}
          {canRevert && (
            <button
              type="button"
              className="btn-ghost btn-ghost-danger"
              onClick={() => setConfirmRevert(true)}
              disabled={busy}
              title={rollbackVersion ? `Revert to ${rollbackVersion}` : 'Revert to the previous image'}
            >
              Revert{rollbackVersion ? ` to ${rollbackVersion}` : ''}
            </button>
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

      {confirmRevert && (
        <ConfirmDialog
          title="Revert to the previous image?"
          message={`This recreates "${name}" from the image it ran before the last update${
            rollbackVersion ? ` (${rollbackVersion})` : ''
          }. Tip: pin the version afterwards, or your next compose update will pull the newer image again.`}
          confirmLabel="Revert"
          onConfirm={handleRevert}
          onCancel={() => setConfirmRevert(false)}
        />
      )}

      {clOpen && (
        <div className="changelog-panel">
          {clLoading && (
            <div className="changelog-loading">
              <span className="spinner" aria-hidden="true" /> Loading release notes…
            </div>
          )}
          {!clLoading && clError && <StatusMessage type="error" message={clError} />}
          {!clLoading && !clError && clData && <ChangelogContent data={clData} />}
        </div>
      )}

      <StreamLog lines={lines} />
    </div>
  );
}
