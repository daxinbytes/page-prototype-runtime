import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createBridge } from '../lib/bridge.mjs';

const token = 'a'.repeat(43);
const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
async function setup(t, project = false) {
  const directory = await mkdtemp(join(tmpdir(), 'prototype-test-'));
  const config = {
    origin: 'https://app.example.test', pagePath: '/app',
    resourceUrl: 'https://app.example.test/test.js',
    originalFile: `${directory}/original.js`, overrideFile: `${directory}/override.js`,
  };
  if (project) { config.projectId = 'test-project'; config.sites = [{ origin: config.origin, pagePath: config.pagePath }]; }
  await writeFile(config.originalFile, 'window.value = "original";');
  await writeFile(config.overrideFile, 'window.value = "changed";');
  const bridge = await createBridge({ config, token });
  bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
  const port = bridge.server.address().port;
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const call = (path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const connect = async (secret = token) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: extensionOrigin });
    await once(ws, 'open');
    const message = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'hello', token: secret, protocolVersion: 3 }));
    return { ws, message };
  };
  return { bridge, config, port, call, connect };
}

test('requires authentication and rejects browser-page origins', async (t) => {
  const { call } = await setup(t);
  assert.equal((await call('/status', null, { Authorization: '' })).status, 401);
  assert.equal((await call('/status', null, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/status')).status, 200);
  assert.equal((await call('/command', { action: 'delete' })).status, 400);
});
test('continuing the active saved scenario rebinds its target without resetting the page', async (t) => {
  const { connect, call } = await setup(t, true);
  const { ws, message } = await connect(); await message;
  const next = once(ws, 'message');
  const request = call('/command', { action: 'scenario-use', scenarioId: 's-initial', tabId: 9 });
  const command = JSON.parse((await next)[0]);
  assert.equal(command.action, 'bind');
  const target = { tabId: 9, url: 'https://app.example.test/app#/plan/index', epoch: 'new-session' };
  ws.send(JSON.stringify({ type: 'result', id: command.id, ok: true, result: target }));
  const response = await (await request).json();
  assert.equal(response.continued, true); assert.deepEqual(response.capture.editTarget, target);
  assert.equal(response.capture.activeScenario.id, 's-initial');
});

test('pairing sends a complete immutable file and status excludes token/body', async (t) => {
  const { connect, call } = await setup(t);
  const { ws, message } = await connect();
  const welcome = JSON.parse((await message)[0]);
  assert.equal(Buffer.from(welcome.snapshot.body, 'base64').toString(), 'window.value = "changed";');
  ws.send(JSON.stringify({ type: 'state', state: { enabled: true, tabId: 3 } }));
  const status = await (await call('/status')).json();
  assert.equal(status.connected, true);
  assert.equal(status.resource.body, undefined);
  assert.equal(JSON.stringify(status).includes(token), false);
});

test('apply reads the new file and waits for a browser acknowledgment', async (t) => {
  const { connect, config, call } = await setup(t);
  const { ws, message } = await connect(); await message;
  await writeFile(config.overrideFile, 'window.value = "second";');
  const commandReceived = once(ws, 'message');
  const request = call('/command', { action: 'apply' });
  const command = JSON.parse((await commandReceived)[0]);
  assert.equal(command.action, 'apply');
  assert.equal(command.snapshot.revision, 2);
  assert.equal(Buffer.from(command.snapshot.body, 'base64').toString(), 'window.value = "second";');
  ws.send(JSON.stringify({ type: 'result', id: command.id, ok: true, result: { reloadRequested: true } }));
  assert.equal((await (await request).json()).result.reloadRequested, true);
});

test('invalid JavaScript is rejected without replacing the last valid snapshot', async (t) => {
  const { connect, config, call } = await setup(t);
  const { message } = await connect(); await message;
  await writeFile(config.overrideFile, 'function {');
  assert.equal((await call('/command', { action: 'apply' })).status, 400);
  assert.equal((await (await call('/status')).json()).resource.revision, 1);
});

test('restore waits for browser result; disconnect rejects an in-flight command', async (t) => {
  const { connect, call } = await setup(t);
  const { ws, message } = await connect(); await message;
  const next = once(ws, 'message');
  const request = call('/command', { action: 'restore' });
  assert.equal(JSON.parse((await next)[0]).action, 'restore');
  ws.close();
  const response = await request;
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /断开/);
});

test('invalid WebSocket pairing closes without sending the override', async (t) => {
  const { port } = await setup(t);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: extensionOrigin });
  await once(ws, 'open');
  let received = false; ws.on('message', () => { received = true; });
  const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'hello', token: 'bad' }));
  assert.equal((await closed)[0], 1008);
  assert.equal(received, false);
});

test('capture receives a file larger than one WebSocket frame; malformed chunk sequences cannot create files', async (t) => {
  const { connect, call } = await setup(t);
  const { ws, message } = await connect(); await message;
  const next = once(ws, 'message');
  const request = call('/command', { action: 'capture', tabId: 3 });
  const command = JSON.parse((await next)[0]);
  const { captureId } = command;
  let id = 0;
  const rpc = async (message) => {
    const acknowledgment = once(ws, 'message');
    ws.send(JSON.stringify({ ...message, id: `upload-${++id}`, captureId }));
    return JSON.parse((await acknowledgment)[0]);
  };
  const bytes = Buffer.from(`//${'x'.repeat(180000)}\nwindow.large = true;`);
  assert.equal((await rpc({ type: 'asset-start', transferId: 'one', metadata: { url: 'https://app.example.test/discovered.js', type: 'Script' } })).ok, true);
  for (let offset = 0, sequence = 0; offset < bytes.length; offset += 49152, sequence++) {
    assert.equal((await rpc({ type: 'asset-chunk', transferId: 'one', sequence, data: bytes.subarray(offset, offset + 49152).toString('base64') })).ok, true);
  }
  const finished = await rpc({ type: 'asset-end', transferId: 'one', bytes: bytes.length });
  assert.equal(finished.ok, true);
  assert.equal(finished.result.capture.resources, 1);
  await rpc({ type: 'asset-start', transferId: 'bad', metadata: { url: 'https://app.example.test/bad.js', type: 'Script' } });
  assert.equal((await rpc({ type: 'asset-chunk', transferId: 'bad', sequence: 2, data: 'eA==' })).ok, false);
  assert.equal((await rpc({ type: 'asset-end', transferId: 'bad', bytes: 1 })).ok, false);
  ws.send(JSON.stringify({ type: 'result', id: command.id, ok: true, result: { captureId } }));
  assert.equal((await request).status, 200);
  const captured = await (await call('/capture')).json();
  assert.equal(captured.manifest.resources.length, 1);
  assert.equal(captured.manifest.resources[0].bytes, bytes.length);
  assert.equal((await call('/command', { action: 'apply' })).status, 400);
});
