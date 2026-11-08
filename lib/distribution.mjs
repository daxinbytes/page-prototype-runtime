import { cp, readdir, lstat, readFile, writeFile, chmod } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const runtimeFiles = ['bin', 'cli.mjs', 'server.mjs', 'lib', 'extension', 'scripts', 'install.mjs', 'package.json', 'package-lock.json', 'README.md'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function validateDistribution(root) {
  const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
  if (release.name !== 'page-prototype-runtime' || !/^\d+\.\d+\.\d+$/.test(release.version) || release.apiVersion !== 1) throw new Error('运行时发行清单不兼容');
  for (const [file, hash] of Object.entries(release.files)) {
    const path = resolve(root, file);
    if (!path.startsWith(`${resolve(root)}${sep}`) || digest(await readFile(path)) !== hash) throw new Error(`发行文件校验失败：${file}`);
  }
  return release;
}
export async function buildDistribution(root, destination) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'page-prototype-runtime' || pkg.pagePrototypeApiVersion !== 1) throw new Error('这不是兼容的页面原型运行时仓库');
  for (const dependency of ['acorn', 'ws']) {
    try { await readFile(join(root, 'node_modules', dependency, 'package.json')); }
    catch { throw new Error('运行依赖尚未安装，请先执行 npm ci --omit=dev --ignore-scripts'); }
  }
  for (const file of runtimeFiles) await cp(join(root, file), join(destination, file), { recursive: true, dereference: false });
  for (const dependency of ['acorn', 'ws']) await cp(join(root, 'node_modules', dependency), join(destination, 'node_modules', dependency), { recursive: true, dereference: false });
  await chmod(join(destination, 'bin/page-prototype.mjs'), 0o755);
  const files = {};
  async function visit(directory) {
    for (const file of (await readdir(directory)).sort()) {
      const path = join(directory, file), info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`发行文件不能是符号链接：${relative(destination, path)}`);
      if (info.isDirectory()) await visit(path);
      else files[relative(destination, path)] = digest(await readFile(path));
    }
  }
  await visit(destination);
  const release = { name: pkg.name, version: pkg.version, apiVersion: pkg.pagePrototypeApiVersion, files };
  await writeFile(join(destination, 'release.json'), JSON.stringify(release, null, 2)); return release;
}
