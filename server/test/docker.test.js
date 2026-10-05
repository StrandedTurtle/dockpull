import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortImageId } from '../src/docker.js';

test('shortImageId: strips the sha256: prefix and truncates to 12 chars', () => {
  assert.equal(
    shortImageId('sha256:a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9'),
    'a1b2c3d4e5f6'
  );
});

test('shortImageId: already-short IDs pass through unchanged', () => {
  assert.equal(shortImageId('a1b2c3d4e5f6'), 'a1b2c3d4e5f6');
});

test('shortImageId: empty / missing input returns an empty string', () => {
  assert.equal(shortImageId(''), '');
  assert.equal(shortImageId(null), '');
  assert.equal(shortImageId(undefined), '');
});

import { pickRepoDigests } from '../src/docker.js';

test('pickRepoDigests: returns every digest for the configured repo, in order', () => {
  const repoDigests = [
    'nginx@sha256:111',
    'ghcr.io/other/nginx@sha256:222',
    'docker.io/library/nginx@sha256:333',
  ];
  assert.deepEqual(pickRepoDigests(repoDigests, 'nginx:latest'), ['sha256:111', 'sha256:333']);
});

test('pickRepoDigests: normalizes Hub namespaces and registries', () => {
  assert.deepEqual(
    pickRepoDigests(['linuxserver/sonarr@sha256:aaa'], 'docker.io/linuxserver/sonarr:latest'),
    ['sha256:aaa']
  );
  assert.deepEqual(
    pickRepoDigests(['registry:5000/team/app@sha256:bbb'], 'registry:5000/team/app:1.2'),
    ['sha256:bbb']
  );
});

test('pickRepoDigests: sole unrelated digest is used as a fallback; several are ambiguous', () => {
  assert.deepEqual(pickRepoDigests(['mirror.local/x@sha256:aaa'], 'nginx:latest'), ['sha256:aaa']);
  assert.deepEqual(
    pickRepoDigests(['mirror.local/x@sha256:aaa', 'mirror.local/y@sha256:bbb'], 'nginx:latest'),
    []
  );
  assert.deepEqual(pickRepoDigests(undefined, 'nginx:latest'), []);
  assert.deepEqual(pickRepoDigests([], 'nginx:latest'), []);
});

import { buildRecreateOptions } from '../src/docker.js';

const ID = 'abcdef1234567890'.padEnd(64, '0');
const baseImage = {
  Env: ['PATH=/usr/bin', 'APP_VERSION=1.0'],
  Cmd: ['serve'],
  Entrypoint: ['/entry'],
  Labels: { 'org.opencontainers.image.version': '1.0' },
  ExposedPorts: { '80/tcp': {} },
  Volumes: { '/data': {} },
  WorkingDir: '/app',
  User: '',
};
const inspect = {
  Id: ID,
  Config: {
    Hostname: ID.slice(0, 12),
    Image: 'app:latest',
    Env: ['PATH=/usr/bin', 'APP_VERSION=1.0', 'TZ=Europe/London'],
    Cmd: ['serve'],
    Entrypoint: ['/entry'],
    Labels: { 'org.opencontainers.image.version': '1.0', 'my.label': 'x' },
    ExposedPorts: { '80/tcp': {}, '9000/tcp': {} },
    Volumes: { '/data': {} },
    WorkingDir: '/app',
    User: '',
  },
  HostConfig: { Binds: ['/srv/conf:/conf:ro'], RestartPolicy: { Name: 'unless-stopped' } },
  Mounts: [
    { Type: 'bind', Source: '/srv/conf', Destination: '/conf' },
    { Type: 'volume', Name: 'f'.repeat(64), Destination: '/data', RW: true },
  ],
  NetworkSettings: {
    Networks: {
      web: { Aliases: ['app', ID.slice(0, 12)], IPAddress: '172.18.0.5', NetworkID: 'n1', EndpointID: 'e1' },
    },
  },
};

test('buildRecreateOptions: drops the old image defaults, keeps user overrides', () => {
  const o = buildRecreateOptions(inspect, baseImage, 'app:latest');
  assert.equal(o.Image, 'app:latest');
  assert.deepEqual(o.Env, ['TZ=Europe/London']); // new image supplies PATH/APP_VERSION
  assert.equal(o.Cmd, undefined);
  assert.equal(o.Entrypoint, undefined);
  assert.equal(o.WorkingDir, undefined);
  assert.deepEqual(o.Labels, { 'my.label': 'x' });
  assert.deepEqual(o.ExposedPorts, { '9000/tcp': {} });
  assert.equal(o.Volumes, undefined);
  assert.equal(o.Hostname, undefined); // default hostname = short ID
  assert.deepEqual(o.HostConfig.RestartPolicy, { Name: 'unless-stopped' });
});

test('buildRecreateOptions: keeps a user-set command and hostname', () => {
  const o = buildRecreateOptions(
    { ...inspect, Config: { ...inspect.Config, Cmd: ['serve', '--debug'], Hostname: 'myhost' } },
    baseImage,
    'app:latest'
  );
  assert.deepEqual(o.Cmd, ['serve', '--debug']);
  assert.equal(o.Hostname, 'myhost');
});

test('buildRecreateOptions: re-attaches anonymous volumes so their data survives', () => {
  const o = buildRecreateOptions(inspect, baseImage, 'app:latest');
  assert.deepEqual(o.HostConfig.Binds, ['/srv/conf:/conf:ro', `${'f'.repeat(64)}:/data`]);
  // Does not mutate the inspect data.
  assert.deepEqual(inspect.HostConfig.Binds, ['/srv/conf:/conf:ro']);
});

test('buildRecreateOptions: network endpoints keep aliases but drop runtime state', () => {
  const o = buildRecreateOptions(inspect, baseImage, 'app:latest');
  assert.deepEqual(o.NetworkingConfig.EndpointsConfig, { web: { Aliases: ['app'] } });
});

test('buildRecreateOptions: without the base image config, everything is kept', () => {
  const o = buildRecreateOptions(inspect, null, 'sha256:old');
  assert.equal(o.Image, 'sha256:old');
  assert.deepEqual(o.Env, inspect.Config.Env);
  assert.deepEqual(o.Cmd, ['serve']);
});

import { trackedImageRef, REF_LABEL, DIGEST_LABEL } from '../src/docker.js';

test('trackedImageRef: a reverted container (bare image ID) tracks its remembered ref', () => {
  const id = `sha256:${'a'.repeat(64)}`;
  assert.equal(trackedImageRef({ Config: { Image: id, Labels: { [REF_LABEL]: 'app:latest' } } }), 'app:latest');
  assert.equal(trackedImageRef({ Config: { Image: 'app:1.2', Labels: { [REF_LABEL]: 'app:latest' } } }), 'app:1.2');
  assert.equal(trackedImageRef({ Config: { Image: 'app:latest' } }), 'app:latest');
  assert.equal(trackedImageRef({ Config: { Image: id } }), id);
});

test('buildRecreateOptions: revert labels never carry over to the next container', () => {
  const o = buildRecreateOptions(
    { ...inspect, Config: { ...inspect.Config, Labels: { ...inspect.Config.Labels, [REF_LABEL]: 'app:latest', [DIGEST_LABEL]: 'sha256:1' } } },
    baseImage,
    'app:latest'
  );
  assert.deepEqual(o.Labels, { 'my.label': 'x' });
});
