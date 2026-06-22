import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config, assertRequiredConfig } from './config.js';
// Importing db creates the data dir + tables as a side effect on load.
import './db.js';
import { webhookRouter } from './webhook.js';
import { apiRouter } from './routes/api.js';

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

app.use(express.json());
app.use(cookieParser());

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// WP2/WP3: routes mounted here
// - WP2 (done): Diun webhook route (POST /api/diun/webhook) — public, its
//   own bearer-token auth, no session cookie.
// - WP2 (done): container listing + history + pin routes (GET
//   /api/containers, GET /api/history(/:name), GET /api/pinned, POST
//   /api/pin, DELETE /api/pin/:ref) — these are meant to be protected by
//   the session cookie per API_CONTRACT.md, but no auth is applied yet.
// - WP3 (todo): insert session-cookie auth middleware here, BEFORE
//   `apiRouter`, so those routes require login. Do not put it before
//   `webhookRouter` — the webhook and /api/health must stay public.
// - WP3 (todo): auth routes (POST /api/auth/login, /api/auth/logout, GET
//   /api/auth/me) and update routes (POST /api/update/:name, GET
//   /api/update/:name/stream).
app.use(webhookRouter);
// WP3: app.use(authMiddleware) should go here, before apiRouter.
app.use(apiRouter);

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

app.listen(config.PORT, () => {
  console.log(`Diun Updater server listening at ${config.BASE_URL} (port ${config.PORT})`);
});
