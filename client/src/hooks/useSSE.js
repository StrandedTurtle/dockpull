import { useEffect, useRef, useState, useCallback } from 'react';
import { API_BASE } from '../api.js';

/**
 * Subscribes to the update SSE stream for a container by name.
 *
 * GET /api/update/:name/stream — see API_CONTRACT.md. Events:
 *   {type:'log', line}                      -> appended to `lines`
 *   {type:'result', success, message}       -> terminal; stored in `result`, stream closes
 *
 * The stream is keyed by container name (not the streamId returned by
 * POST /api/update/:name — that value is informational only).
 */
const RECONNECT_GRACE_MS = 30_000;

export function useSSE(name, active) {
  const [lines, setLines] = useState([]);
  const [result, setResult] = useState(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState(null);
  const esRef = useRef(null);

  const reset = useCallback(() => {
    setLines([]);
    setResult(null);
    setError(null);
  }, []);

  useEffect(() => {
    if (!active || !name) {
      return;
    }

    setError(null);
    setConnected(false);

    const es = new EventSource(`${API_BASE}/update/${encodeURIComponent(name)}/stream`);
    esRef.current = es;
    // Pending "give up reconnecting" timer while the browser retries.
    let giveUp = null;

    es.onopen = () => {
      clearTimeout(giveUp);
      giveUp = null;
      setConnected(true);
      // The server replays the whole buffered log to every (re)connection, so
      // start fresh rather than duplicating what we already showed.
      setLines([]);
    };

    es.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        // Ignore malformed events rather than crashing the stream handler.
        return;
      }

      if (!payload || typeof payload !== 'object') return;

      if (payload.type === 'log') {
        setLines((prev) => [...prev, payload.line]);
      } else if (payload.type === 'result') {
        setResult({ success: !!payload.success, message: payload.message });
        setConnected(false);
        es.close();
      }
    };

    es.onerror = () => {
      setConnected(false);
      // A blip (phone sleeping, proxy hiccup) is not a failed update: the
      // browser reconnects on its own and the update keeps running server-side.
      // Only report failure if the stream is closed for good, or stays down.
      if (es.readyState === EventSource.CLOSED) {
        setError('Connection lost');
        return;
      }
      if (!giveUp) {
        giveUp = setTimeout(() => {
          es.close();
          setError('Connection lost — the update may still be running. Refresh to check.');
        }, RECONNECT_GRACE_MS);
      }
    };

    return () => {
      clearTimeout(giveUp);
      es.close();
      esRef.current = null;
    };
  }, [name, active]);

  return { lines, result, connected, error, reset };
}
