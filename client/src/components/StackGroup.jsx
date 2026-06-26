import React, { useCallback, useState } from 'react';

const Chevron = ({ open }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    className={`stack-chevron${open ? ' is-open' : ''}`}
  >
    <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * A collapsible section grouping a stack's containers. Open/closed state is
 * remembered per-group in localStorage so it survives reloads.
 *
 * props:
 *  - title: stack/group name shown in the header
 *  - count: number of containers in the group
 *  - updateCount: number with an update available (shown as a badge when > 0)
 *  - storageKey: stable key for persisting open/closed
 *  - defaultOpen: initial state when nothing is stored
 *  - children: the cards
 */
export default function StackGroup({ title, count, updateCount = 0, storageKey, defaultOpen = true, children }) {
  const key = `dockpull.group.${storageKey}`;
  const [open, setOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? defaultOpen : stored === '1';
    } catch {
      return defaultOpen;
    }
  });

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(key, next ? '1' : '0');
      } catch {
        // ignore storage failures (private mode etc.)
      }
      return next;
    });
  }, [key]);

  return (
    <section className="stack-group">
      <button
        type="button"
        className="stack-group-header"
        onClick={toggle}
        aria-expanded={open}
      >
        <Chevron open={open} />
        <span className="stack-group-title truncate" title={title}>
          {title}
        </span>
        {updateCount > 0 && <span className="badge stack-group-badge">{updateCount}</span>}
        <span className="stack-group-count">{count}</span>
      </button>
      {open && <div className="stack-group-body">{children}</div>}
    </section>
  );
}
