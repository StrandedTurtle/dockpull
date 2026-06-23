import dotenv from 'dotenv';

dotenv.config();

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const config = {
  PORT: envInt('PORT', 5000),
  STACKS_DIR: process.env.STACKS_DIR || '/stacks',
  DOCKER_SOCKET: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
  DATA_DIR: process.env.DATA_DIR || '/data',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  SESSION_SECRET: process.env.SESSION_SECRET || '',
  DIUN_WEBHOOK_TOKEN: process.env.DIUN_WEBHOOK_TOKEN || '',
  SESSION_TTL: envInt('SESSION_TTL', 604800),
  BASE_URL: process.env.BASE_URL || 'http://localhost:5000',
};

/**
 * Throws a clear error listing any required env vars that are missing.
 * Required at runtime (but not enforced here so this module can be
 * imported freely, e.g. in tests): ADMIN_PASSWORD, SESSION_SECRET,
 * DIUN_WEBHOOK_TOKEN.
 */
export function assertRequiredConfig() {
  const required = ['ADMIN_PASSWORD', 'SESSION_SECRET', 'DIUN_WEBHOOK_TOKEN'];
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Set them in your .env file or environment before starting the server.'
    );
  }
}

export default config;
