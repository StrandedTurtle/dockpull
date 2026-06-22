import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { config, assertRequiredConfig } from './config.js';
// Importing db creates the data dir + tables as a side effect on load.
import './db.js';

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
// - WP2: auth routes (POST /api/auth/login, /api/auth/logout, GET /api/auth/me)
// - WP3: container listing + update routes (GET /api/containers, POST /api/update/:name, ...)
// - WP3: Diun webhook route (POST /api/diun/webhook)
// - WP3: history + pin routes (GET /api/history, GET/POST/DELETE /api/pinned, /api/pin)

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
