import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import vm from 'node:vm';
import { WebSocket } from 'ws';
import { ProjectSession } from '../extension/project-session.js';
import { ProjectRegistry } from '../lib/project-registry.mjs';
import { CaptureStore } from '../lib/captures.mjs';
import { createBridge } from '../lib/bridge.mjs';

test('a selected saved scenario can be previewed after connecting the current page without an old binding', async () => {
  const code = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
  const start = code.indexOf('function renderScenarios()'), end = code.indexOf('async function render()', start);
  const tab = { id: 9, url: 'https://a.test/app/list', loading: false, overridden: false };
  const state = { connected: true, active: true, binding: null, currentTab: tab, trackedTabs: [tab], capture: { selected: ['r'], activeScenario: { id: 'saved', name: 'Saved', draftCount: 1 }, scenarios: [{ id: 'saved', name: 'Saved' }] } };
  const nodes = new Map(), $ = id => { if (!nodes.has(id)) nodes.set(id, { dataset: {}, replaceChildren() {}, add() {} }); return nodes.get(id); };
  const context = vm.createContext({ state, busy: false, scenarioSignature: '', $, current: () => state.currentTab, tracked: () => state.trackedTabs.find(t => t.id === state.currentTab.id), Option: class {} });
  vm.runInContext(code.slice(start, end) + '\nrenderScenarios()', context);
  assert.equal($('apply').disabled, false);
  assert.equal($('apply').dataset.action, 'preview');
  state.trackedTabs = []; vm.runInContext('renderScenarios()', context);
  assert.equal($('apply').disabled, true); assert.match($('preview-source').textContent, /接入/);
});

test('manual preview validates the clicked URL and resource set before changing the target', async t => {
  const previous = globalThis.chrome; t.after(() => { globalThis.chrome = previous; });
  const url = 'https://a.test/app/list';
  globalThis.chrome = { tabs: { get: async () => ({ id: 9, url, title: 'List' }) } };
  const session = new ProjectSession({ rpc: async () => ({}), change: () => {} });
  session.accept({ projectId: 'p', projectName: 'P', sites: [{ origin: 'https://a.test', pagePath: '/app' }], resources: [] });
  session.active = true;
  session.tabs.set(9, { id: 9, url, collector: { urls: new Set(['https://a.test/list.js']) } });
  session.binding = { tabId: 8, url: 'https://a.test/app/old', epoch: session.epoch };
  const old = session.binding;
  let applied;
  session.apply = async (snapshot, binding, id) => { applied = { binding, id }; return applied; };
  const snapshot = { resources: [{ resourceUrl: 'https://a.test/list.js' }] };
  await assert.rejects(session.preview(snapshot, 9, 'https://a.test/app/other'), /跳转/);
  await assert.rejects(session.preview({ resources: [{ resourceUrl: 'https://a.test/missing.js' }] }, 9, url), /资源/);
  assert.equal(session.binding, old); assert.equal(applied, undefined);
  await session.preview(snapshot, 9, url);
  assert.equal(applied.id, 9); assert.equal(applied.binding.url, url); assert.equal(applied.binding.epoch, session.epoch);
});

test('selecting a scenario before page attachment is repaired atomically by manual preview and old project tasks stay rejected', async t => {
  const root = await mkdtemp(join(tmpdir(), 'prototype-preview-')); t.after(() => rm(root, { recursive: true, force: true }));
  const registry = new ProjectRegistry(root), config = await registry.load(await registry.create('Project'));
  const url = 'https://a.test/app/list'; await registry.attach(config, { url, title: 'List' });
  const store = new CaptureStore(join(root, 'captures'), config); await store.load();
  const scenario = await store.scenarios.create('Saved');
  const resource = await store.ingest({ captureId: store.manifest.id, url: 'https://a.test/list.js', type: 'Script' }, Buffer.from('window.color="original"'));
  const [draft] = await store.stage([resource.resourceId]); await writeFile(draft.overridePath, 'window.color="blue"');
  const token = 'x'.repeat(43), bridge = await createBridge({ token, runtimeRoot: root, captureRoot: join(root, 'captures') });
  await new Promise(done => bridge.server.listen(0, '127.0.0.1', done)); t.after(() => bridge.close());
  const port = bridge.server.address().port;
  const api = async (body, path = '/command') => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json() }; };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `chrome-extension://${'a'.repeat(32)}` }); await once(ws, 'open');
  let snapshot, active = false, trackedTabs = []; const commands = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw); if (m.snapshot) snapshot = m.snapshot;
    const state = () => ws.send(JSON.stringify({ type: 'state', state: { active, contextId: snapshot.contextId, trackedTabs, capabilities: ['projects', 'scenarios', 'verified-apply'] } }));
    if (m.type === 'welcome' || m.type === 'capture-state') { state(); return; }
    if (m.type !== 'command') return; commands.push(m.action); let result = {};
    if (m.action === 'end') { active = false; trackedTabs = []; }
    if (m.action === 'page-info') result = { tabId: 9, url, title: 'List' };
    if (m.action === 'capture') { active = true; trackedTabs = [{ id: 9, url, loading: false }]; result = { tabId: 9 }; }
    if (m.action === 'preview') {
      trackedTabs = [{ id: 9, url, revision: snapshot.revision, outcomes: { 'https://a.test/list.js': 'applied' }, appliedURLs: ['https://a.test/list.js'] }];
      result = { tabId: 9, revision: snapshot.revision, binding: { tabId: 9, url, epoch: 'current-session', title: 'List' } };
    }
    state(); ws.send(JSON.stringify({ type: 'result', id: m.id, ok: true, result }));
  });
  const hello = once(ws, 'message'); ws.send(JSON.stringify({ type: 'hello', token, protocolVersion: 4 })); await hello;
  await api({ action: 'project-use', projectId: config.projectId });
  await api({ action: 'scenario-use', scenarioId: scenario.id });
  await api({ action: 'page-attach', tabId: 9, url });
  assert.equal((await api(null, '/status')).data.capture.editTarget, null);
  const result = await api({ action: 'preview', tabId: 9, url, expectedProjectId: config.projectId, expectedScenarioId: scenario.id });
  assert.equal(result.status, 200); assert.equal(result.data.verified, true);
  assert.equal(result.data.capture.editTarget.tabId, 9); assert.equal(commands.at(-1), 'preview');
  const count = commands.length;
  assert.equal((await api({ action: 'preview', tabId: 9, url, expectedProjectId: 'old-project', expectedScenarioId: scenario.id })).status, 400);
  assert.equal((await api({ action: 'preview', tabId: 9, url, expectedProjectId: config.projectId, expectedScenarioId: 'old-scenario' })).status, 400);
  assert.equal(commands.length, count);
  ws.close();
});
