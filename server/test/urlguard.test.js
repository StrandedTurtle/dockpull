import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, isSafeWebhookUrl, assertPublicWebhookUrl } from '../src/urlguard.js';

test('isPrivateIp: classifies IPv4 ranges', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.10', '172.16.0.1', '172.31.255.255', '169.254.169.254', '0.0.0.0', '100.64.0.1']) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1']) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

test('isPrivateIp: classifies IPv6 (loopback, ULA, link-local, mapped)', () => {
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('fc00::1'), true);
  assert.equal(isPrivateIp('fd12:3456::1'), true);
  assert.equal(isPrivateIp('fe80::1'), true);
  assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateIp('2606:4700:4700::1111'), false);
});

test('isSafeWebhookUrl: requires https + public host', () => {
  assert.equal(isSafeWebhookUrl('https://discord.com/api/webhooks/1/abc'), true);
  assert.equal(isSafeWebhookUrl('https://1.1.1.1/hook'), true);
  // rejected: non-https
  assert.equal(isSafeWebhookUrl('http://discord.com/api/webhooks/1/abc'), false);
  // rejected: internal hosts
  assert.equal(isSafeWebhookUrl('https://localhost/x'), false);
  assert.equal(isSafeWebhookUrl('https://app.local/x'), false);
  assert.equal(isSafeWebhookUrl('https://127.0.0.1/x'), false);
  assert.equal(isSafeWebhookUrl('https://10.0.0.1/x'), false);
  assert.equal(isSafeWebhookUrl('https://192.168.0.1/x'), false);
  assert.equal(isSafeWebhookUrl('https://169.254.169.254/latest/meta-data'), false);
  assert.equal(isSafeWebhookUrl('https://[::1]/x'), false);
  // rejected: junk
  assert.equal(isSafeWebhookUrl('not-a-url'), false);
  assert.equal(isSafeWebhookUrl(''), false);
  assert.equal(isSafeWebhookUrl(null), false);
});

test('assertPublicWebhookUrl: throws unsafe_url for internal, resolves IP literals', async () => {
  await assert.rejects(() => assertPublicWebhookUrl('http://discord.com/x'), /not allowed/);
  await assert.rejects(() => assertPublicWebhookUrl('https://127.0.0.1/x'), /not allowed/);
  await assert.rejects(() => assertPublicWebhookUrl('https://10.1.2.3/x'), /not allowed/);
  // Public IP literal skips DNS and passes.
  await assert.doesNotReject(() => assertPublicWebhookUrl('https://1.1.1.1/x'));
});
