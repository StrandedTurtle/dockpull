import React, { useEffect, useRef, useState } from 'react';

// Heuristic: lines that look like docker/compose error output get the
// "stderr" treatment. The SSE payload only gives us `line`, not a stream
// name, so this is a best-effort color cue rather than a hard signal.
function isLikelyStderr(line) {
  if (typeof line !== 'string') return false;
  return /error|fail|fatal|denied|cannot|unable/i.test(line);
}

/**
 * Expandable, terminal-style log viewer. Auto-scrolls to bottom as new
 * lines arrive while expanded.
 */
export default function StreamLog({ lines, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const viewportRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const el = viewportRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines, open]);

  return (
    <div>
      <button
        type="button"
        className="stream-log-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? 'Hide logs' : `Show logs${lines.length ? ` (${lines.length})` : ''}`}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
        >
          <path
            d="M6 9l6 6 6-6"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className="stream-log" ref={viewportRef}>
          {lines.length === 0 ? (
            <div className="log-empty">No log output yet…</div>
          ) : (
            lines.map((line, idx) => (
              <div
                key={idx}
                className={`log-line ${isLikelyStderr(line) ? 'stderr' : 'stdout'}`}
              >
                {line}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
