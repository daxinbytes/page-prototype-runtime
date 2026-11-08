import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installationHome } from '../lib/installation-home.mjs';

async function userDirectory(t) {
  const path = await mkdtemp(join(tmpdir(), 'prototype-home-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
test('fresh installs use the new name while upgrades keep the existing data and extension location', async (t) => {
  const userHome = await userDirectory(t), environment = {};
  assert.equal(await installationHome({ userHome, environment }), join(userHome, '.page-prototype'));
  const legacy = join(userHome, '.beta-preview'); await mkdir(legacy);
  await writeFile(join(legacy, 'installation.json'), '{}');
  assert.equal(await installationHome({ userHome, environment }), legacy);
  await assert.rejects(access(join(userHome, '.page-prototype')), { code: 'ENOENT' });
  const current = join(userHome, '.page-prototype'); await mkdir(current);
  await writeFile(join(current, 'installation.json'), '{}');
  assert.equal(await installationHome({ userHome, environment }), current);
});
test('explicit install location and new or legacy environment variables retain priority', async (t) => {
  const userHome = await userDirectory(t);
  const old = join(userHome, 'legacy-custom'), next = join(userHome, 'new-custom'), explicit = join(userHome, 'requested');
  assert.equal(await installationHome({ userHome, environment: { BETA_PREVIEW_HOME: old } }), old);
  assert.equal(await installationHome({ userHome, environment: { BETA_PREVIEW_HOME: old, PAGE_PROTOTYPE_HOME: next } }), next);
  assert.equal(await installationHome({ userHome, requested: explicit, environment: { PAGE_PROTOTYPE_HOME: next } }), explicit);
});
