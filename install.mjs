import { readFile, mkdir, writeFile, cp, rename, access, rm } from 'node:fs/promises';
import { resolve, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { installationHome } from './lib/installation-home.mjs';
import { buildDistribution, validateDistribution } from './lib/distribution.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const options = {}, args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--update') options.update = true;
  else if (args[i] === '--home' && args[i + 1] && !args[i + 1].startsWith('--')) options.home = args[++i];
  else throw new Error('用法：node install.mjs [--home 数据目录] [--update]。Skill 请通过 npx skills 独立安装。');
}
if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('运行时需要 Node.js 20 或更新版本');
const home = await installationHome({ requested: options.home });
if (home === root || home.startsWith(`${root}${sep}`)) throw new Error('数据目录必须位于源码或发行包目录之外');
const exists = async (path) => { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (pkg.name !== 'page-prototype-runtime' || pkg.pagePrototypeApiVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('运行时版本或接口不兼容');
if (await exists(join(root, 'release.json'))) await validateDistribution(root);
let previous;
try { previous = JSON.parse(await readFile(join(home, 'installation.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (previous && previous.version !== pkg.version && !options.update) throw new Error('已有工具，请先结束协作并停止服务，再添加 --update 升级；资料会保留');
let running = false;
try {
  const connection = JSON.parse(await readFile(join(home, 'runtime/connection.json'), 'utf8'));
  const token = (await readFile(join(home, 'runtime/token'), 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${connection.port}/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
  running = response.ok;
} catch {}
if (running) throw new Error('本地服务仍在运行，请先结束协作并停止服务，再安装或更新');
const versions = join(home, 'versions'); await mkdir(versions, { recursive: true, mode: 0o700 });
let staging = join(versions, `.install-${randomUUID()}`); await mkdir(staging);
const backups = [];
try {
  const release = await buildDistribution(root, staging);
  const target = join(versions, release.version);
  let identical = false;
  if (await exists(target)) {
    try { identical = JSON.stringify(await validateDistribution(target)) === JSON.stringify(release); } catch {}
    if (!identical && !options.update) throw new Error('已有同版本文件且内容不同，请核对后添加 --update；旧文件会备份');
  }
  if (identical) { await rm(staging, { recursive: true, force: true }); staging = null; }
  else {
    if (await exists(target)) { const backup = `${target}.backup-${Date.now()}`; await rename(target, backup); backups.push(backup); }
    await rename(staging, target); staging = null;
  }
  const extension = join(home, 'extension'), extensionStage = join(home, `.extension-${randomUUID()}`);
  await cp(join(target, 'extension'), extensionStage, { recursive: true });
  if (await exists(extension)) { const backup = join(home, `extension-backup-${Date.now()}`); await rename(extension, backup); backups.push(backup); }
  await rename(extensionStage, extension);
  const installation = { name: 'page-prototype-runtime', version: release.version, apiVersion: release.apiVersion,
    tool: join(target, 'bin/page-prototype.mjs'), runtime: join(home, 'runtime'), extension };
  const temporary = join(home, `installation-${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(installation, null, 2), { mode: 0o600 });
  await rename(temporary, join(home, 'installation.json'));
  console.log(JSON.stringify({ installed: true, ...installation, backups, next: '运行时已安装。在 Chrome 加载 extension 目录；Skill 由独立仓库维护。' }, null, 2));
} finally { if (staging) await rm(staging, { recursive: true, force: true }); }
