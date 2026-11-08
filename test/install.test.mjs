import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { buildDistribution, validateDistribution } from '../lib/distribution.mjs';

const run = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'prototype-install-'));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
const install = (source, home, ...args) => run(process.execPath, [join(source, 'install.mjs'), '--home', home, ...args]);
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('source install contains runtime only and preserves data when reinstalled or upgraded', async (t) => {
  const parent = await temporary(t), home = join(parent, 'home');
  const result = JSON.parse((await install(root, home)).stdout);
  assert.equal(result.version, '0.7.0'); assert.equal(result.apiVersion, 1);
  assert.equal(result.extension, join(home, 'extension'));
  const installedRoot = resolve(result.tool, '../..');
  const release = await validateDistribution(installedRoot);
  assert.equal(Object.keys(release.files).some((file) => /SKILL\.md|^skills?\//.test(file)), false);
  assert.equal(Object.keys(release.files).some((file) => /^(?:\.runtime|captures\/|test\/)/.test(file)), false);
  const runtime = join(home, 'runtime'); await mkdir(join(runtime, 'projects'), { recursive: true });
  await writeFile(join(runtime, 'token'), 'test-pairing-value');
  await writeFile(join(runtime, 'projects/preserved.json'), '{"draft":"preserved"}');
  await install(root, home);
  const doctor = JSON.parse((await run(process.execPath, [result.tool, 'doctor'], { env: { ...process.env, PAGE_PROTOTYPE_HOME: home } })).stdout);
  assert.equal(doctor.extensionDirectory, result.extension);
  const record = await readJson(join(home, 'installation.json'));
  await writeFile(join(home, 'installation.json'), JSON.stringify({ ...record, version: '0.6.0', apiVersion: undefined }));
  await assert.rejects(install(root, home), /--update/);
  await install(root, home, '--update');
  assert.equal(await readFile(join(runtime, 'token'), 'utf8'), 'test-pairing-value');
  assert.equal(await readFile(join(runtime, 'projects/preserved.json'), 'utf8'), '{"draft":"preserved"}');
  assert.equal((await readJson(join(home, 'installation.json'))).extension, result.extension);
  await writeFile(join(installedRoot, 'cli.mjs'), '// modified installation');
  await assert.rejects(install(root, home), /--update/);
  await install(root, home, '--update');
  await validateDistribution(installedRoot);
  assert.ok((await readdir(join(home, 'versions'))).some((name) => name.startsWith('0.7.0.backup-')));
});

test('install refuses to replace an active service', async (t) => {
  const home = await temporary(t); await mkdir(join(home, 'runtime'));
  const server = createServer((request, response) => { response.writeHead(request.url === '/status' && request.headers.authorization === 'Bearer test-pairing-value' ? 200 : 403); response.end('{}'); });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  await writeFile(join(home, 'runtime/connection.json'), JSON.stringify({ port: server.address().port }));
  await writeFile(join(home, 'runtime/token'), 'test-pairing-value');
  await assert.rejects(install(root, home, '--update'), /本地服务仍在运行/);
  await assert.rejects(readFile(join(home, 'installation.json')), { code: 'ENOENT' });
});

test('standalone distribution installs without npm or Skill and detects changed files', async (t) => {
  const parent = await temporary(t), distribution = join(parent, 'distribution'), home = join(parent, 'home');
  await mkdir(distribution); await buildDistribution(root, distribution);
  await install(distribution, home);
  assert.equal((await readJson(join(home, 'installation.json'))).name, 'page-prototype-runtime');
  await writeFile(join(distribution, 'extension/popup.js'), '// changed');
  await assert.rejects(install(distribution, join(parent, 'rejected')), /发行文件校验失败/);
  await assert.rejects(readFile(join(parent, 'rejected/installation.json')), { code: 'ENOENT' });
});
