/**
 * Single-password session auth.
 *
 * There are no user accounts — just one shared `ADMIN_PASSWORD`, compared in
 * constant time. On success we set a signed, httpOnly cookie
 * (`dockpull_session`) whose value is the absolute expiry timestamp (ms since
 * epoch). Validity is just "signature ok (handled by cookie-parser) AND
 * expiry is in the future" — no server-side session store needed.
 */

import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';

export const authRouter = express.Router();

const SESSION_COOKIE = 'dockpull_session';

// --- Simple in-memory login rate limiting ---------------------------------
// Per-client-IP failed-attempt tracking with a lockout, to blunt brute-force
// of the single shared password. Not a substitute for keeping the app off the
// open internet, but a sane default for a tool that may be exposed. State is
// in-memory (resets on restart), which is fine for a single-instance app.
const MAX_FAILURES = 10; // failures allowed within the window before lockout
const FAILURE_WINDOW_MS = 15 * 60 * 1000; // rolling window for counting failures
const LOCKOUT_MS = 15 * 60 * 1000; // how long a lockout lasts once tripped

const loginAttempts = new Map(); // ip -> { count, firstAt, lockedUntil }

// Bound the map: once it grows past this, expired entries are swept on the
// next recorded failure, so a wide scan from many IPs can't grow it forever.
const MAX_TRACKED_IPS = 10000;

function pruneLoginAttempts(now) {
  for (const [ip, a] of loginAttempts) {
    const windowExpired = now - a.firstAt > FAILURE_WINDOW_MS;
    const lockoutExpired = !a.lockedUntil || a.lockedUntil <= now;
    if (windowExpired && lockoutExpired) loginAttempts.delete(ip);
  }
}

export function isLockedOut(ip, now = Date.now()) {
  const a = loginAttempts.get(ip);
  return Boolean(a && a.lockedUntil && a.lockedUntil > now);
}

export function recordLoginFailure(ip, now = Date.now()) {
  if (loginAttempts.size >= MAX_TRACKED_IPS) pruneLoginAttempts(now);
  let a = loginAttempts.get(ip);
  if (!a || now - a.firstAt > FAILURE_WINDOW_MS) {
    a = { count: 0, firstAt: now, lockedUntil: 0 };
  }
  a.count += 1;
  if (a.count >= MAX_FAILURES) {
    a.lockedUntil = now + LOCKOUT_MS;
  }
  loginAttempts.set(ip, a);
  return a;
}

export function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

/**
 * Constant-time comparison of the supplied password against
 * `config.ADMIN_PASSWORD`. Guards against length mismatches
 * (timingSafeEqual throws if buffers differ in length) and always fails if
 * ADMIN_PASSWORD is unset/empty (never allow an empty password to "match"
 * an empty configured password).
 *
 * @param {string} provided
 * @returns {boolean}
 */
function isValidPassword(provided) {
  const expected = config.ADMIN_PASSWORD;
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected === '') {
    return false;
  }
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Reads `req.signedCookies.dockpull_session` and checks whether it represents a
 * non-expired session. cookie-parser has already verified the HMAC
 * signature by the time a value shows up in `signedCookies` (a
 * tampered/forged cookie ends up `undefined`/`false` there instead), so we
 * only need to check presence + expiry here.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function isValidSession(req) {
  const value = req.signedCookies?.[SESSION_COOKIE];
  if (!value) return false;
  const expiry = Number(value);
  if (!Number.isFinite(expiry)) return false;
  return expiry > Date.now();
}

/**
 * POST /api/auth/login — body { password }. Sets a signed session cookie on
 * success.
 */
export function loginHandler(req, res) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  if (isLockedOut(ip)) {
    return res.status(429).json({ error: 'too_many_attempts' });
  }

  const password = req.body?.password;

  if (!isValidPassword(password)) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: 'invalid_password' });
  }

  clearLoginFailures(ip);
  const expiry = String(Date.now() + config.SESSION_TTL * 1000);
  res.cookie(SESSION_COOKIE, expiry, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.BASE_URL.startsWith('https'),
    maxAge: config.SESSION_TTL * 1000,
    path: config.BASE_PATH || '/',
  });

  return res.status(200).json({ ok: true });
}

/**
 * POST /api/auth/logout — clears the session cookie. Public: clearing a
 * cookie that may not even be valid is harmless.
 */
export function logoutHandler(req, res) {
  // Must match the path the cookie was set with, or the browser won't clear it.
  res.clearCookie(SESSION_COOKIE, { path: config.BASE_PATH || '/' });
  return res.status(200).json({ ok: true });
}

/**
 * GET /api/auth/me — reports current auth status. Never errors.
 */
export function meHandler(req, res) {
  return res.status(200).json({ authenticated: isValidSession(req) });
}

/**
 * Auth gate for the rest of the API. Lets non-`/api/*` requests through
 * unconditionally (static assets, SPA fallback). For `/api/*` requests,
 * requires a valid session cookie.
 */
export function requireAuth(req, res, next) {
  if (!req.path.startsWith('/api/')) {
    return next();
  }
  if (isValidSession(req)) {
    return next();
  }
  return res.status(401).json({ error: 'unauthorized' });
}

authRouter.post('/api/auth/login', loginHandler);
authRouter.post('/api/auth/logout', logoutHandler);
authRouter.get('/api/auth/me', meHandler);

export default authRouter;
