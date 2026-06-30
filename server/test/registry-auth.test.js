import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { basicAuthForRegistry, _resetAuthCache } from '../src/registry-auth.js';

function writeConfig(auths) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockpull-docker-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ auths }));
  process.env.DOCKER_CONFIG = dir;
  _resetAuthCache();
  return dir;
}

const ghcrB64 = Buffer.from('user:pat').toString('base64');
const hubB64 = Buffer.from('hubuser:hubpass').toString('base64');

test('basicAuthForRegistry: ghcr by host', () => {
  writeConfig({ 'ghcr.io': { auth: ghcrB64 } });
  assert.equal(basicAuthForRegistry('ghcr.io'), ghcrB64);
  assert.equal(basicAuthForRegistry('quay.io'), null);
});

test('basicAuthForRegistry: docker hub matched via index.docker.io key', () => {
  writeConfig({ 'https://index.docker.io/v1/': { auth: hubB64 } });
  assert.equal(basicAuthForRegistry('docker.io'), hubB64);
  assert.equal(basicAuthForRegistry('registry-1.docker.io'), hubB64);
});

test('basicAuthForRegistry: derives base64 from username/password', () => {
  writeConfig({ 'ghcr.io': { username: 'user', password: 'pat' } });
  assert.equal(basicAuthForRegistry('ghcr.io'), ghcrB64);
});

test('basicAuthForRegistry: no config -> null', () => {
  process.env.DOCKER_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'dockpull-empty-'));
  _resetAuthCache();
  assert.equal(basicAuthForRegistry('ghcr.io'), null);
});
