import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isValidSession, requireAuth } from '../src/auth.js';

function makeReq({ signedCookies = {}, path = '/api/containers' } = {}) {
  return { signedCookies, path };
}

describe('isValidSession', () => {
  test('returns false when there is no signed cookie', () => {
    assert.equal(isValidSession(makeReq({ signedCookies: {} })), false);
  });

  test('returns false when cookie-parser rejected the signature (false in signedCookies)', () => {
    assert.equal(isValidSession(makeReq({ signedCookies: { diun_session: false } })), false);
  });

  test('returns false when the expiry is in the past', () => {
    const expired = String(Date.now() - 1000);
    assert.equal(isValidSession(makeReq({ signedCookies: { diun_session: expired } })), false);
  });

  test('returns false when the cookie value is not numeric', () => {
    assert.equal(isValidSession(makeReq({ signedCookies: { diun_session: 'not-a-number' } })), false);
  });

  test('returns true when the expiry is in the future', () => {
    const future = String(Date.now() + 1000 * 60);
    assert.equal(isValidSession(makeReq({ signedCookies: { diun_session: future } })), true);
  });
});

describe('requireAuth', () => {
  test('passes non-/api/ requests through regardless of session state', () => {
    const req = makeReq({ signedCookies: {}, path: '/some/static/asset.js' });
    let nextCalled = false;
    const res = { status: () => { throw new Error('should not respond'); } };
    requireAuth(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });

  test('responds 401 for /api/ requests with no valid session', () => {
    const req = makeReq({ signedCookies: {}, path: '/api/containers' });
    let statusCode = null;
    let body = null;
    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        body = payload;
        return this;
      },
    };
    let nextCalled = false;
    requireAuth(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 401);
    assert.deepEqual(body, { error: 'unauthorized' });
  });

  test('calls next() for /api/ requests with a valid session', () => {
    const future = String(Date.now() + 1000 * 60);
    const req = makeReq({ signedCookies: { diun_session: future }, path: '/api/containers' });
    const res = { status: () => { throw new Error('should not respond'); } };
    let nextCalled = false;
    requireAuth(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });
});
