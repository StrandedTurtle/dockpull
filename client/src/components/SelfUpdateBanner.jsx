import React, { useCallback, useEffect, useState } from 'react';
import { getSelfUpdate } from '../api.js';

const DISMISS_KEY = 'dockpull.selfUpdate.dismissed';
const UPDATE_COMMAND = 'docker compose pull dockpull && docker compose up -d dockpull';

/**
 * "A newer DockPull is available" banner. Read-only on purpose: DockPull never
 * updates its own container (that would recreate the process doing the
 * update), so this explains what changed and how to update by hand. Dismissed
 * per version; any failure to check just shows nothing.
 */
export default function SelfUpdateBanner() {
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(null); // null | 'notes' | 'how'
  const [copied, setCopied] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) || '';
    } catch {
      return '';
    }
  });

  useEffect(() => {
    let cancelled = false;
    getSelfUpdate()
      .then((d) => {
        if (!cancelled && d?.available) setInfo(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(() => {
    if (!info) return;
    try {
      localStorage.setItem(DISMISS_KEY, info.latest);
    } catch {
      // private mode etc. — just hide for this page view
    }
    setDismissed(info.latest);
  }, [info]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(UPDATE_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked (http, permissions) — the command is visible to copy by hand
    }
  }, []);

  if (!info || dismissed === info.latest) return null;

  return (
    <div className="self-update" role="status">
      <div className="self-update-row">
        <span className="self-update-text">
          <strong>DockPull {info.latest}</strong> is available — you're on {info.current}.
        </span>
        <span className="self-update-actions">
          <button type="button" className="btn-ghost" onClick={() => setOpen(open === 'notes' ? null : 'notes')}>
            {open === 'notes' ? 'Hide' : "What's new"}
          </button>
          <button type="button" className="btn-ghost" onClick={() => setOpen(open === 'how' ? null : 'how')}>
            How to update
          </button>
          <button type="button" className="banner-dismiss" onClick={dismiss} aria-label="Dismiss until the next version">
            ×
          </button>
        </span>
      </div>

      {open === 'how' && (
        <div className="self-update-panel">
          <p>
            DockPull doesn't update itself (replacing the container it runs in would cut the update
            off half-way). On your server, in the folder with DockPull's compose file, run:
          </p>
          <div className="self-update-cmd">
            <code>{UPDATE_COMMAND}</code>
            <button type="button" className="btn btn-sm" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="self-update-note">
            Using Dockge? Open DockPull's stack and press <strong>Update</strong>. Built from source?
            Run <code>git pull &amp;&amp; docker compose up -d --build</code>. Your settings and history
            are kept.
          </p>
        </div>
      )}

      {open === 'notes' && (
        <div className="self-update-panel">
          {info.releases.map((r) => (
            <div className="changelog-release" key={r.tag}>
              <div className="changelog-release-head">
                <a href={r.url} target="_blank" rel="noopener noreferrer">
                  {r.tag}
                </a>
                {r.publishedAt && (
                  <span className="changelog-date">{new Date(r.publishedAt).toLocaleDateString()}</span>
                )}
              </div>
              {r.body && <pre className="changelog-body">{r.body}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
