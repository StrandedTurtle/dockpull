/**
 * Single-password session auth.
 *
 * There are no user accounts — just one shared `ADMIN_PASSWORD`, compared in
 * constant time. On success we set a signed, httpOnly cookie
 * (`diun_session`) whose value is the absolute expiry timestamp (ms since
 * epoch). Validity is just "signature ok (handled by cookie-parser) AND
 * expiry is in the future" — no server-side session store needed.
 */

import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';

export const authRouter = express.Router();

const SESSION_COOKIE = 'diun_session';

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
 * Reads `req.signedCookies.diun_session` and checks whether it represents a
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
  const password = req.body?.password;

  if (!isValidPassword(password)) {
    return res.status(401).json({ error: 'invalid_password' });
  }

  const expiry = String(Date.now() + config.SESSION_TTL * 1000);
  res.cookie(SESSION_COOKIE, expiry, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.BASE_URL.startsWith('https'),
    maxAge: config.SESSION_TTL * 1000,
    path: '/',
  });

  return res.status(200).json({ ok: true });
}

/**
 * POST /api/auth/logout — clears the session cookie. Public: clearing a
 * cookie that may not even be valid is harmless.
 */
export function logoutHandler(req, res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
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
