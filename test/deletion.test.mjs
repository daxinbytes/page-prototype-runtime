import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { ProjectRegistry } from '../lib/project-registry.mjs';
import { CaptureStore } from '../lib/captures.mjs';
import { createBridge } from '../lib/bridge.mjs';
import { pageKey } from '../extension/page-identity.js';
import { matchesProject } from '../extension/project-session.js';

async function temp(t) { const root = await mkdtemp(join(tmpdir(), 'prototype-delete-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function makeProject(registry, name) {
  const config = await registry.load(await registry.create(name));
  await registry.attach(config, { url: 'https://a.test/app/detail?id=1', title: 'Shared detail' });
  return config;
}
test('moving a page out preserves the other project and prevents automatic reattachment until an explicit join', async t => {
  const root = await temp(t), registry = new ProjectRegistry(root);
  const a = await makeProject(registry, 'A'), b = await makeProject(registry, 'B'), key = pageKey('https://a.test/app/detail?id=2');
  const removed = await registry.removePage(a, key);
  assert.equal(a.savedPages.length, 0); assert.equal(b.savedPages.length, 1);
  assert.equal(matchesProject(a, 'https://a.test/app/detail?id=3'), false);
  assert.equal(matchesProject(b, 'https://a.test/app/detail?id=3'), true);
  assert.equal(matchesProject(a, 'https://a.test/app/list'), true);
  await assert.rejects(registry.remember(a, { url: 'https://a.test/app/detail?id=4' }, true), /移出/);
  const restarted = await new ProjectRegistry(root).load(a.projectId);
  assert.equal(matchesProject(restarted, 'https://a.test/app/detail?id=3'), false);
  assert.equal(JSON.parse(await readFile(join(removed.archiveDirectory, 'record.json'), 'utf8')).page.key, key);
  await registry.attach(restarted, { url: 'https://a.test/app/detail?id=5' });
  assert.equal(restarted.savedPages.length, 1); assert.equal(matchesProject(restarted, 'https://a.test/app/detail?id=6'), true);
});
test('deleting a project archives only its own configuration and files', async t => {
  const root = await temp(t), registry = new ProjectRegistry(root), a = await makeProject(registry, 'A'), b = await makeProject(registry, 'B');
  for (const config of [a, b]) { await mkdir(join(root, 'captures', `project-${config.projectId}`), { recursive: true }); await writeFile(join(root, 'captures', `project-${config.projectId}`, 'draft.js'), config.name); }
  const result = await registry.remove(a.projectId);
  assert.equal((await registry.refresh()).length, 1);
  await assert.rejects(access(registry.path(a.projectId)), { code: 'ENOENT' });
  assert.equal(await readFile(join(result.archiveDirectory, 'capture/draft.js'), 'utf8'), 'A');
  assert.equal(await readFile(join(root, 'captures', `project-${b.projectId}`, 'draft.js'), 'utf8'), 'B');
  await assert.rejects(registry.remove('../outside'), /ID/);
});
test('deleting the active or an inactive scenario preserves other drafts and all original resources', async t => {
  const root = await temp(t), registry = new ProjectRegistry(root), config = await makeProject(registry, 'A');
  const store = new CaptureStore(join(root, 'captures'), config); await store.load();
  const resource = await store.ingest({ captureId: store.manifest.id, url: 'https://a.test/app.js', type: 'Script' }, Buffer.from('window.color="original"'));
  const a = await store.scenarios.create('A'); const [draftA] = await store.stage([resource.resourceId]); await writeFile(draftA.overridePath, 'window.color="blue"');
  const b = await store.scenarios.create('B'); const [draftB] = await store.stage([resource.resourceId]); await writeFile(draftB.overridePath, 'window.color="green"');
  const active = await store.scenarios.remove(b.id, root);
  assert.equal(store.scenarios.summary(), null); assert.deepEqual(store.manifest.selected, []);
  assert.match(await readFile(join(active.archiveDirectory, 'scenario/overrides', `${resource.resourceId}.js`), 'utf8'), /green/);
  assert.match(await readFile(draftA.overridePath, 'utf8'), /blue/);
  const c = await store.scenarios.create('C');
  await store.scenarios.remove(a.id, root); assert.equal(store.scenarios.summary().id, c.id);
  assert.match(await readFile(store.manifest.resources[0].path, 'utf8'), /original/);
  await assert.rejects(store.scenarios.remove('foreign-id', root), /没有这个方案/);
});
test('destructive control commands restore the browser first, reject stale contexts and leave data intact when restoration fails', async t => {
  const root = await temp(t), token = 't'.repeat(43), registry = new ProjectRegistry(root), config = await makeProject(registry, 'A');
  const setupStore = new CaptureStore(join(root, 'captures'), config); await setupStore.load();
  const scheme = await setupStore.scenarios.create('Saved');
  const bridge = await createBridge({ token, runtimeRoot: root, captureRoot: join(root, 'captures') });
  await new Promise(done => bridge.server.listen(0, '127.0.0.1', done)); t.after(() => bridge.close());
  const port = bridge.server.address().port;
  const api = async body => { const r = await fetch(`http://127.0.0.1:${port}/command`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `chrome-extension://${'a'.repeat(32)}` }); await once(ws, 'open');
  let snapshot, fail = false; const events = [];
  ws.on('message', async raw => {
    const m = JSON.parse(raw); if (m.snapshot) snapshot = m.snapshot;
    if (m.type === 'welcome' || m.type === 'capture-state') { ws.send(JSON.stringify({ type: 'state', state: { active: false, contextId: snapshot.contextId, capabilities: ['scenarios','projects','deletion'] } })); return; }
    if (m.type !== 'command') return;
    events.push(m.action);
    if (m.action === 'clear-preview') await access(join(root, 'captures', `project-${config.projectId}`, 'scenarios', scheme.id));
    if (m.action === 'end') await access(registry.path(config.projectId));
    ws.send(JSON.stringify({ type: 'result', id: m.id, ok: !fail, result: {}, error: fail ? 'restore failed' : undefined }));
  });
  const hello = once(ws, 'message'); ws.send(JSON.stringify({ type: 'hello', token, protocolVersion: 4 })); await hello;
  assert.equal((await api({ action: 'project-use', projectId: config.projectId })).status, 200);
  assert.equal((await api({ action: 'scenario-use', scenarioId: scheme.id })).status, 200);
  fail = true;
  assert.equal((await api({ action: 'scenario-delete', scenarioId: scheme.id, expectedProjectId: config.projectId })).status, 400);
  assert.equal(events.at(-1), 'clear-preview');
  let manifest = JSON.parse(await readFile(join(root, 'captures', `project-${config.projectId}`, 'manifest.json'), 'utf8'));
  assert.equal(manifest.scenarios.length, 1);
  fail = false;
  assert.equal((await api({ action: 'scenario-delete', scenarioId: scheme.id, expectedProjectId: 'wrong-project' })).status, 400);
  assert.equal((await api({ action: 'scenario-delete', scenarioId: scheme.id, expectedProjectId: config.projectId })).status, 200);
  assert.equal(events.at(-1), 'clear-preview');
  assert.equal((await api({ action: 'page-remove', key: config.savedPages[0].key, expectedProjectId: config.projectId })).status, 200);
  assert.equal(events.at(-1), 'remove-page');
  fail = true; assert.equal((await api({ action: 'project-delete', projectId: config.projectId })).status, 400); await access(registry.path(config.projectId));
  fail = false; assert.equal((await api({ action: 'project-delete', projectId: config.projectId })).status, 200); assert.equal(events.at(-1), 'end');
  ws.close();
});
