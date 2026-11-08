import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProject, listProjects, resolveProject } from '../lib/project-configs.mjs';
import { searchSources, draftChanges } from '../lib/inspection.mjs';
import { verifyApplication } from '../lib/client.mjs';

async function temp(t) { const dir = await mkdtemp(join(tmpdir(), 'beta-tool-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
test('project initialization preserves existing configs and strips URL query/fragment', async (t) => {
  const root = await temp(t);
  const args = ['--name', '中文项目', '--id', 'demo', '--url', 'https://a.test/app?token=private#/list', '--url', 'https://b.test/app', '--path', '/app'];
  const first = await initializeProject(root, args);
  assert.deepEqual(first.project.sites, [{ origin: 'https://a.test', pagePath: '/app' }, { origin: 'https://b.test', pagePath: '/app' }]);
  assert.ok(!(await readFile(first.configPath, 'utf8')).includes('private'));
  assert.equal((await initializeProject(root, args)).configPath, first.configPath);
  await assert.rejects(initializeProject(root, ['--name', '另一个项目', '--id', 'demo', '--url', 'https://c.test']), /已有不同配置/);
  assert.equal((await listProjects(root))[0].name, '中文项目');
  assert.equal(await resolveProject(root, root, 'demo'), first.configPath);
});
test('source search returns evidence lines and excludes dependencies by default', async (t) => {
  const root = await temp(t), path = join(root, 'source.vue'); await writeFile(path, 'const coverage = 20;\nconst premium = 1040;');
  const manifest = { sources: [{ id: 's1', label: 'src/Plan.vue', path, resourceIds: ['r1', 'r2'] }, { id: 's2', dependency: true, path }, { id: 's3', path: null }] };
  const found = await searchSources(manifest, 'premium');
  assert.equal(found.results.length, 1); assert.equal(found.results[0].line, 2); assert.deepEqual(found.results[0].resourceIds, ['r1', 'r2']); assert.equal(found.missing, 1);
  assert.equal((await searchSources(manifest, 'const', { limit: 1 })).truncated, true);
  assert.equal((await searchSources(manifest, 'premium', { dependencies: true })).results.length, 2);
});
test('change summary keeps original files untouched and includes bound target', async (t) => {
  const root = await temp(t), path = join(root, 'original.js'), overridePath = join(root, 'draft.js');
  await writeFile(path, 'const 文案 = "搜索";'); await writeFile(overridePath, 'const 文案 = "AI 搜索";');
  const result = await draftChanges({ selected: ['r1'], editTarget: { tabId: 9 }, resources: [{ id: 'r1', path, overridePath }] });
  assert.equal(result.target.tabId, 9); assert.equal(result.files[0].changed, true); assert.match(result.files[0].changeRegion.after, /AI 搜索/);
  assert.equal(await readFile(path, 'utf8'), 'const 文案 = "搜索";');
});
test('apply verification waits for every selected resource in the requested revision', async () => {
  let checks = 0;
  const call = async () => ({ connected: true, extension: { trackedTabs: [{ id: 8, revision: 3, outcomes: {}, appliedURLs: ++checks > 1 ? ['a', 'b'] : ['a'] }] } });
  const result = await verifyApplication(call, { tabId: 8, revision: 3, expectedURLs: ['a', 'b'], timeout: 1000 });
  assert.equal(result.verified, true); assert.ok(checks >= 2);
  const failure = async () => ({ connected: true, extension: { trackedTabs: [{ id: 8, revision: 3, outcomes: { a: 'applied', b: 'mismatch' }, appliedURLs: ['a'] }] } });
  await assert.rejects(verifyApplication(failure, { tabId: 8, revision: 3, expectedURLs: ['a', 'b'] }), /mismatch/);
  await assert.rejects(verifyApplication(call, { tabId: 8, revision: 4, expectedURLs: ['a'], timeout: 0 }), /超时/);
});
