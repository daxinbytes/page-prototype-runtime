import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeProject, matchesProject } from '../extension/project-session.js';
import { fileURLToPath } from 'node:url';
import { loadConfig, readSnapshot } from '../lib/workspace.mjs';

test('preview profile selects preview site through the real extension filter without a preconfigured override', async () => {
  const config = await loadConfig(fileURLToPath(new URL('../examples/preview.json', import.meta.url)));
  const value = await readSnapshot(config, 1);
  assert.deepEqual(value.resources, []);
  const project = normalizeProject(value);
  const result = {
    preview: matchesProject(project, 'https://preview.example.test/app#/custom/plan'),
    previous: matchesProject(project, 'https://app.example.test/app#/plan/index'),
    unrelated: matchesProject(project, 'https://example.com/app'),
    resourceCount: value.resources.length,
  };
  assert.equal(result.preview, true);
  assert.equal(result.previous, false);
  assert.equal(result.unrelated, false);
  assert.equal(result.resourceCount, 0);
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
  assert.ok(manifest.optional_host_permissions.includes('https://*/*'));
});
