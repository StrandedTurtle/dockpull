/**
 * Per-container update session manager: buffers log lines + the final
 * result for an in-progress (or just-finished) container update, and
 * replays them to SSE subscribers.
 *
 * The frontend does `POST /api/update/:name` and THEN opens
 * `GET /api/update/:name/stream` — there's an inherent race between
 * "update starts producing log lines" and "the stream connects". To avoid
 * dropping early lines, every line (and the final result) is buffered in
 * memory and replayed in full to whoever subscribes, whenever they
 * subscribe — including after the update has already finished, for a
 * grace period.
 *
 * Dependency-free: only touches the `res` objects handed to it.
 */

const sessions = new Map();

const FINISHED_SESSION_TTL_MS = 30_000;

/**
 * @param {string} name
 * @returns {boolean} true if a session exists for `name` and hasn't
 *   finished yet.
 */
export function isActive(name) {
  const session = sessions.get(name);
  return Boolean(session) && !session.done;
}

/**
 * Starts a new update session for `name`.
 *
 * @param {string} name
 * @returns {object|false} the new session object, or `false` if one is
 *   already active and not yet done (caller should respond 409).
 */
export function startSession(name) {
  if (isActive(name)) {
    return false;
  }

  const session = {
    lines: [],
    result: null,
    subscribers: new Set(),
    done: false,
    timer: null,
  };

  sessions.set(name, session);
  return session;
}

/**
 * Appends a log line to the session's buffer and writes it to every
 * currently-connected subscriber.
 *
 * @param {string} name
 * @param {string} line
 * @param {'stdout'|'stderr'} [stream]
 */
export function pushLog(name, line, stream) {
  const session = sessions.get(name);
  if (!session) return;

  const evt = { type: 'log', line, stream };
  session.lines.push(evt);
  writeToSubscribers(session, evt);
}

/**
 * Marks the session as finished: records the final result, writes it to
 * every subscriber, ends their responses, and schedules the session for
 * deletion after a grace period (so a late subscriber can still replay
 * the buffered lines + get the result).
 *
 * @param {string} name
 * @param {{ success: boolean, message: string }} result
 */
export function finish(name, result) {
  const session = sessions.get(name);
  if (!session) return;

  const evt = { type: 'result', success: result?.success, message: result?.message };
  session.result = evt;
  session.done = true;

  writeToSubscribers(session, evt);
  for (const res of session.subscribers) {
    try {
      clearInterval(res.__sseKeepAlive);
      res.end();
    } catch {
      // ignore — subscriber may already be gone
    }
  }
  session.subscribers.clear();

  session.timer = setTimeout(() => {
    sessions.delete(name);
  }, FINISHED_SESSION_TTL_MS);
}

/**
 * Subscribes `res` to the update session for `name`: sets SSE headers,
 * replays all buffered lines, then either streams further events live or
 * (if the session is already done) writes the result and ends. If no
 * session exists at all, writes a single synthetic "no active update"
 * result so the client doesn't hang waiting forever.
 *
 * @param {string} name
 * @param {import('express').Response} res
 * @param {import('express').Request} [req]
 */
export function subscribe(name, res, req) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Tell nginx (and similar) not to buffer the stream, or log lines would
    // be held back until the response closed.
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const session = sessions.get(name);

  if (!session) {
    const evt = {
      type: 'result',
      success: false,
      message: 'No active update for this container.',
    };
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
    res.end();
    return;
  }

  for (const evt of session.lines) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }

  if (session.result) {
    res.write(`data: ${JSON.stringify(session.result)}\n\n`);
    res.end();
    return;
  }

  session.subscribers.add(res);

  // Heartbeat so reverse proxies don't drop an idle connection during a long
  // pull with sparse output. SSE comment lines (": ...") are ignored by the
  // EventSource client, so they don't show up as log lines.
  const keepAlive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      // subscriber is gone; the close handler will clear this interval
    }
  }, 15_000);
  res.__sseKeepAlive = keepAlive;

  const cleanup = () => {
    clearInterval(keepAlive);
    session.subscribers.delete(res);
  };
  res.on('close', cleanup);
  if (req) {
    req.on('close', cleanup);
  }
}

/**
 * @param {object} session
 * @param {object} evt
 */
function writeToSubscribers(session, evt) {
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of session.subscribers) {
    try {
      res.write(payload);
    } catch {
      // ignore — subscriber may have already disconnected
    }
  }
}

// --- Global event channel -------------------------------------------------
// A lightweight broadcast channel, separate from per-update sessions, used to
// nudge connected dashboards to refresh when something changes server-side: a
// manual or scheduled check, or a finished update.
const globalClients = new Set();

export function subscribeGlobal(res, req) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
  res.write(': connected\n\n');

  globalClients.add(res);
  const keepAlive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      // gone; close handler clears the interval
    }
  }, 15_000);

  const cleanup = () => {
    clearInterval(keepAlive);
    globalClients.delete(res);
  };
  res.on('close', cleanup);
  if (req) {
    req.on('close', cleanup);
  }
}

export function broadcastGlobal(evt) {
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of globalClients) {
    try {
      res.write(payload);
    } catch {
      // subscriber gone; its close handler will clean it up
    }
  }
}

export default {
  startSession,
  isActive,
  pushLog,
  finish,
  subscribe,
  subscribeGlobal,
  broadcastGlobal,
};
