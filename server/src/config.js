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
  SESSION_TTL: envInt('SESSION_TTL', 604800),
  BASE_URL: process.env.BASE_URL || 'http://localhost:5000',
  // Name of this app's own container, excluded from the dashboard so it
  // can't try to update (and kill) itself. Defaults to the container_name
  // used in the shipped docker-compose.yml; override if you rename it.
  SELF_CONTAINER_NAME: process.env.SELF_CONTAINER_NAME || 'diun-updater',
};

/**
 * Throws a clear error listing any required env vars that are missing.
 * Required at runtime (but not enforced here so this module can be
 * imported freely, e.g. in tests): ADMIN_PASSWORD, SESSION_SECRET.
 */
export function assertRequiredConfig() {
  const required = ['ADMIN_PASSWORD', 'SESSION_SECRET'];
  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Set them in your .env file or environment before starting the server.'
    );
  }
}

export default config;
