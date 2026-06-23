/**
 * Diun webhook ingest: POST /api/diun/webhook
 *
 * Auth is a static bearer token (DIUN_WEBHOOK_TOKEN), compared in constant
 * time — separate from the session-cookie auth used by the rest of the API
 * (see API_CONTRACT.md "Auth model").
 */

import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { normalizeRef } from './reconcile.js';
import { recordEvent } from './db.js';

export const webhookRouter = express.Router();

const DEFAULT_STATUS = 'update';

/**
 * Constant-time comparison of the bearer token against the configured
 * DIUN_WEBHOOK_TOKEN. Guards against length mismatches (timingSafeEqual
 * throws if buffers differ in length) without leaking timing information
 * about the length itself beyond the unavoidable minimum.
 *
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
function isValidToken(provided, expected) {
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

webhookRouter.post('/api/diun/webhook', (req, res) => {
  const authHeader = req.get('authorization') || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  const token = match ? match[1] : null;

  if (!isValidToken(token, config.DIUN_WEBHOOK_TOKEN)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = req.body || {};
  const image = body.image;
  if (typeof image !== 'string' || image.trim() === '') {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  const status = body.status || DEFAULT_STATUS;
  const digest = body.digest ?? null;

  let normalizedRef;
  try {
    normalizedRef = normalizeRef(image);
  } catch {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  recordEvent({
    image,
    normalized_ref: normalizedRef,
    status,
    digest,
    raw_json: JSON.stringify(req.body),
  });

  return res.status(204).end();
});

export default webhookRouter;
