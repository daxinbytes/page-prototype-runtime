import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { ProjectRegistry } from '../lib/project-registry.mjs';
import { CaptureStore } from '../lib/captures.mjs';
import { createBridge } from '../lib/bridge.mjs';
import { pageKey, scopeForPage, matchesScope } from '../extension/page-identity.js';
import { matchesProject } from '../extension/project-session.js';

async function temp(t) { const root = await mkdtemp(join(tmpdir(), 'prototype-manager-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
test('page identity ignores record id but preserves business routes, hash routes and module parameters', () => {
  assert.equal(pageKey('https://a.test/app/detail?id=1'), pageKey('https://a.test/app/detail?id=2'));
  assert.equal(pageKey('https://a.test/app/#/detail?id=1'), pageKey('https://a.test/app/#/detail?id=2'));
  assert.notEqual(pageKey('https://a.test/?module=a&id=1'), pageKey('https://a.test/?module=b&id=1'));
  assert.notEqual(pageKey('https://a.test/#/list'), pageKey('https://a.test/#/detail'));
});
test('automatic following stays inside an approved application, including root hash applications', () => {
  const rule = scopeForPage('https://a.test/app/list');
  assert.equal(matchesScope(rule, 'https://a.test/app/detail?id=2'), true);
  assert.equal(matchesScope(rule, 'https://a.test/other/list'), false);
  assert.equal(matchesScope(rule, 'https://b.test/app/list'), false);
  const hash = scopeForPage('https://a.test/#/app/list');
  assert.equal(matchesScope(hash, 'https://a.test/#/app/detail?id=2'), true);
  assert.equal(matchesScope(hash, 'https://a.test/#/other/list'), false);
  assert.equal(matchesScope(scopeForPage('https://a.test/'), 'https://a.test/unrelated'), false);
});
test('saved pages survive registry reloads and may belong to two independent projects', async t => {
  const root = await temp(t), registry = new ProjectRegistry(root);
  const a = await registry.load(await registry.create('A')), b = await registry.load(await registry.create('B'));
  assert.deepEqual(a.savedPages, []);
  await registry.attach(a, { url: 'https://a.test/app/list', title: 'List' });
  await registry.attach(a, { url: 'https://preview.test/app/detail?id=1', title: 'Preview' });
  await registry.remember(a, { url: 'https://preview.test/app/detail?id=2' }, true);
  await registry.attach(b, { url: 'https://a.test/app/list', title: 'Shared' });
  const reopened = new ProjectRegistry(root);
  assert.equal((await reopened.load(a.projectId)).savedPages.length, 2);
  assert.equal((await reopened.load(b.projectId)).savedPages.length, 1);
  assert.equal((await reopened.load(a.projectId)).savedPages[0].title, 'List');
  const stores = [new CaptureStore(join(root, 'captures'), a), new CaptureStore(join(root, 'captures'), b)];
  const drafts = [];
  for (const store of stores) {
    await store.load(); assert.equal(store.scenarios.summary(), null);
    await store.scenarios.create('Independent');
    const resource = await store.ingest({ captureId: store.manifest.id, url: 'https://a.test/app.js', type: 'Script' }, Buffer.from('window.color="original"'));
    drafts.push((await store.stage([resource.resourceId]))[0].overridePath);
  }
  assert.notEqual(drafts[0], drafts[1]);
  await writeFile(drafts[0], 'window.color="blue"'); await writeFile(drafts[1], 'window.color="green"');
  assert.match(await readFile(drafts[0], 'utf8'), /blue/);
  assert.match(await readFile(drafts[1], 'utf8'), /green/);
});
test('old whole-domain configuration preserves historical evidence but requires scope confirmation', async t => {
  const root = await temp(t); await mkdir(join(root, 'projects')); await mkdir(join(root, 'captures/project-old'), { recursive: true });
  await writeFile(join(root, 'projects/old.json'), JSON.stringify({ projectId: 'old', name: 'Old', port: 17373, sites: [{ origin: 'https://a.test', pagePath: '/' }] }));
  const old = JSON.stringify({ pages: [{ url: 'https://a.test/app/list' }, { url: 'https://a.test/other/list' }], evidence: 'preserve' });
  await writeFile(join(root, 'captures/project-old/manifest.json'), old);
  const registry = new ProjectRegistry(root), config = await registry.load('old');
  assert.equal(config.savedPages.length, 2); assert.equal(config.savedPages[0].needsReview, true);
  assert.equal(matchesProject(config, 'https://a.test/other/list'), false);
  await registry.attach(config, { url: 'https://a.test/app/list' });
  assert.equal(matchesProject(config, 'https://a.test/app/detail'), true);
  assert.equal(matchesProject(config, 'https://a.test/other/list'), false);
  assert.equal(await readFile(join(root, 'captures/project-old/manifest.json'), 'utf8'), old);
});
test('a new managed project never imports another legacy project draft just because the origin matches', async t => {
  const root = await temp(t), captureRoot = join(root, 'captures');
  const legacy = new CaptureStore(captureRoot, { origin: 'https://a.test', pagePath: '/' });
  await legacy.begin();
  const resource = await legacy.ingest({ captureId: legacy.manifest.id, url: 'https://a.test/app.js', type: 'Script' }, Buffer.from('window.color="original"'));
  const [draft] = await legacy.stage([resource.resourceId]); await writeFile(draft.overridePath, 'window.color="legacy"');
  const registry = new ProjectRegistry(root), config = await registry.load(await registry.create('Fresh'));
  await registry.attach(config, { url: 'https://a.test/app/list' });
  const fresh = new CaptureStore(captureRoot, config); await fresh.load();
  assert.equal(fresh.manifest.resources.length, 0); assert.deepEqual(fresh.scenarios.list(), []);
  assert.match(await readFile(draft.overridePath, 'utf8'), /legacy/);
});
test('manager starts idle, switches only after restoration, preserves pages, and rejects stale project tasks/uploads', async t => {
  const root = await temp(t), token = 'a'.repeat(43);
  const registry = new ProjectRegistry(root), a = await registry.create('A'), b = await registry.create('B');
  const bridge = await createBridge({ token, runtimeRoot: root, captureRoot: join(root, 'captures') });
  await new Promise(resolve => bridge.server.listen(0, '127.0.0.1', resolve));
  t.after(() => bridge.close());
  const port = bridge.server.address().port;
  const api = async (body, path = '/command') => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await api(null, '/status')).data.workspace.selectedProjectId, null);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `chrome-extension://${'a'.repeat(32)}` });
  await once(ws, 'open'); let snapshot, active = false; const commands = [];
  let finishUpload;
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'upload-ack') { finishUpload?.(m); return; }
    if (m.snapshot) snapshot = m.snapshot;
    const state = () => ws.send(JSON.stringify({ type: 'state', state: { contextId: snapshot?.contextId, active, capabilities: ['scenarios', 'projects'] } }));
    if (m.type === 'welcome' || m.type === 'capture-state') { state(); return; }
    if (m.type !== 'command') return;
    commands.push(m.action);
    let result = {};
    if (m.action === 'end') active = false;
    if (m.action === 'page-info') result = { url: 'https://a.test/app/list', title: 'List', tabId: 1 };
    if (m.action === 'capture') { active = true; result = { tabId: 1, following: 1 }; }
    state(); ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result }));
  });
  const hello = once(ws, 'message'); ws.send(JSON.stringify({ type: 'hello', token, protocolVersion: 4 })); await hello;
  assert.equal((await api({ action: 'project-use', projectId: a })).status, 200);
  assert.equal(commands.at(-1), 'end');
  const oldContext = (await api(null, '/status')).data.workspace.contextId;
  assert.equal((await api({ action: 'page-attach', tabId: 1, expectedProjectId: a })).status, 200);
  assert.equal((await api({ action: 'project-use', projectId: b, expectedProjectId: a })).status, 200);
  assert.equal(commands.at(-1), 'end');
  assert.equal((await api({ action: 'apply', expectedProjectId: a })).status, 400);
  assert.equal((await api({ action: 'project-use', projectId: a })).status, 200);
  const current = (await api(null, '/status')).data;
  assert.equal(current.workspace.pages.length, 1); assert.equal(current.capture.activeScenario, null);
  assert.notEqual(current.workspace.contextId, oldContext);
  const rejected = new Promise(resolve => { finishUpload = resolve; });
  ws.send(JSON.stringify({ type: 'asset-page', id: 'late', captureId: current.capture.id, contextId: oldContext, url: 'https://a.test/app/old' }));
  assert.equal((await rejected).ok, false);
  ws.close();
});
