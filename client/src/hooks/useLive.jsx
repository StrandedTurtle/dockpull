import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, getJobs } from '../api.js';

/**
 * App-wide live state, shared by every page:
 *
 *  - ONE EventSource to /api/events; components subscribe to event types
 *    (`useLiveEvent`) instead of each opening their own connection.
 *  - The server's update queue (GET /api/jobs): which containers are queued,
 *    updating, or finished recently, and the current "Update all" batch.
 *
 * Updates run on the server, so this is what lets any page — or a different
 * device — show what's in progress. It re-reads the queue whenever the server
 * says it changed, when the event stream reconnects, and when the tab/app
 * becomes visible again (phones pause background tabs and drop events).
 */
const LiveContext = createContext({
  jobs: [],
  jobsByName: new Map(),
  batch: null,
  refreshJobs: () => {},
  subscribe: () => () => {},
});

export function LiveProvider({ children }) {
  const [state, setState] = useState({ jobs: [], batch: null });
  const listenersRef = useRef(new Map()); // type -> Set<fn>
  const refreshTimer = useRef(null);

  const refreshJobs = useCallback(() => {
    getJobs()
      .then((d) => setState({ jobs: Array.isArray(d?.jobs) ? d.jobs : [], batch: d?.batch ?? null }))
      .catch(() => {});
  }, []);

  // Coalesce bursts (a batch emits several changes in quick succession).
  const scheduleRefresh = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(refreshJobs, 200);
  }, [refreshJobs]);

  const emit = useCallback((type, payload) => {
    for (const fn of listenersRef.current.get(type) || []) {
      try {
        fn(payload);
      } catch {
        // a listener's bug shouldn't break the stream
      }
    }
  }, []);

  useEffect(() => {
    refreshJobs();
    let es;
    try {
      es = new EventSource(`${API_BASE}/events`);
      // (Re)connected: anything may have changed while we were away.
      es.onopen = () => {
        scheduleRefresh();
        emit('reconnected');
      };
      es.onmessage = (e) => {
        let payload;
        try {
          payload = JSON.parse(e.data);
        } catch {
          return;
        }
        if (!payload?.type) return;
        if (payload.type === 'jobs-changed') scheduleRefresh();
        emit(payload.type, payload);
      };
    } catch {
      // EventSource unavailable — pages still work, just without live refresh.
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        refreshJobs();
        emit('reconnected');
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(refreshTimer.current);
      document.removeEventListener('visibilitychange', onVisible);
      if (es) es.close();
    };
  }, [refreshJobs, scheduleRefresh, emit]);

  const subscribe = useCallback((type, fn) => {
    const map = listenersRef.current;
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(fn);
    return () => map.get(type)?.delete(fn);
  }, []);

  const value = useMemo(() => {
    const jobsByName = new Map(state.jobs.map((j) => [j.name, j]));
    return { jobs: state.jobs, jobsByName, batch: state.batch, refreshJobs, subscribe };
  }, [state, refreshJobs, subscribe]);

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive() {
  return useContext(LiveContext);
}

/** Call `handler` whenever the server emits an event of `type`. */
export function useLiveEvent(type, handler) {
  const { subscribe } = useLive();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe(type, (p) => ref.current(p)), [subscribe, type]);
}

/** True while a job is queued or running. */
export function isActiveJob(job) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}
