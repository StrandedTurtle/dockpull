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

    es.onopen = () => {
      setConnected(true);
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
      setError('Connection lost');
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [name, active]);

  return { lines, result, connected, error, reset };
}
