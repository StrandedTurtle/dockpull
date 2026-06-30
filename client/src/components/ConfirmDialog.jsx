import React, { useEffect, useRef } from 'react';

/**
 * Minimal accessible confirm dialog for destructive actions. Renders an overlay
 * with a title, message, and Cancel / Confirm buttons. Escape or an overlay
 * click cancels; the confirm button is focused on open.
 *
 * @param {{
 *   title: string,
 *   message?: string,
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 *   confirming?: boolean,
 *   onConfirm: () => void,
 *   onCancel: () => void,
 * }} props
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirming = false,
  onConfirm,
  onCancel,
}) {
  const confirmRef = useRef(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape' && !confirming) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, confirming]);

  return (
    <div
      className="confirm-overlay"
      onClick={() => {
        if (!confirming) onCancel();
      }}
    >
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="confirm-title" className="confirm-title">
          {title}
        </h3>
        {message && <p className="confirm-message">{message}</p>}
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={confirming}>
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className="btn btn-danger"
            onClick={onConfirm}
            disabled={confirming}
          >
            {confirming && <span className="spinner" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
