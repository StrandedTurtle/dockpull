import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config, assertRequiredConfig } from './config.js';
// Importing db creates the data dir + tables as a side effect on load.
import db from './db.js';
import { webhookRouter } from './webhook.js';
import { authRouter, requireAuth } from './auth.js';
import { apiRouter } from './routes/api.js';
import { updateRouter } from './routes/update.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (process.env.SKIP_CONFIG_CHECK !== '1') {
  try {
    assertRequiredConfig();
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
} else {
  console.warn('SKIP_CONFIG_CHECK=1 set — skipping required env var validation.');
}

const app = express();
app.disable('x-powered-by');

app.use(express.json());
app.use(cookieParser(config.SESSION_SECRET));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// WP2/WP3: routes mounted here, in order:
// 1. Diun webhook route (POST /api/diun/webhook) — public, its own
//    bearer-token auth, no session cookie.
// 2. Auth routes (POST /api/auth/login, POST /api/auth/logout, GET
//    /api/auth/me) — public; login/me must be reachable without a
//    session, and logout is harmless without one.
// 3. `requireAuth` — session-cookie gate for everything under `/api/*`
//    mounted after this point; passes through non-`/api/*` requests
//    (static assets, SPA fallback) untouched.
// 4. Container listing + history + pin routes (GET /api/containers, GET
//    /api/history(/:name), GET /api/pinned, POST /api/pin, DELETE
//    /api/pin/:ref) and update routes (POST /api/update/:name, GET
//    /api/update/:name/stream) — now protected by `requireAuth` above.
app.use(webhookRouter);
app.use(authRouter);
app.use(requireAuth);
app.use(apiRouter);
app.use(updateRouter);

const clientDistDir = path.join(__dirname, '..', '..', 'client', 'dist');
const clientDistExists = fs.existsSync(path.join(clientDistDir, 'index.html'));

if (clientDistExists) {
  app.use(express.static(clientDistDir));

  // SPA fallback: any non-/api route serves index.html.
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(clientDistDir, 'index.html'));
  });
} else {
  console.warn(`No client build found at ${clientDistDir} — skipping static file serving.`);
}

const server = app.listen(config.PORT, () => {
  console.log(`Diun Updater server listening at ${config.BASE_URL} (port ${config.PORT})`);
});

// Graceful shutdown: stop accepting connections and checkpoint/close SQLite
// so a `docker stop` doesn't leave the WAL or an in-flight write half-done.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down…`);
  server.close(() => {
    try {
      db.close();
    } catch {
      // already closed / nothing to do
    }
    process.exit(0);
  });
  // Don't hang forever if a connection (e.g. an open SSE stream) won't close.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
