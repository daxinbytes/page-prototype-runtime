import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256, loadConfig } from './workspace.mjs';

export async function initializeProject(runtime, args) {
  const options = {}, urls = [];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--name', '--url', '--id', '--path', '--port'].includes(key) || !value || value.startsWith('--')) throw new Error('init 参数：--name 名称 --url 页面地址 [--url 另一个地址] [--id 项目ID] [--path 页面路径] [--port 端口]');
    if (key === '--url') urls.push(value); else options[key] = value;
  }
  if (!options['--name']?.trim() || !urls.length) throw new Error('请提供 --name 和至少一个 --url');
  const scope = options['--path'] || '/';
  if (!scope.startsWith('/') || /[?#*]/.test(scope)) throw new Error('--path 必须是路径，不含查询参数、hash 或通配符');
  const sites = [];
  for (const value of urls) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('项目页面必须是没有内嵌凭据的 HTTP(S) 地址');
    if (!sites.some((site) => site.origin === url.origin)) sites.push({ origin: url.origin, pagePath: scope.replace(/\/$/, '') || '/' });
  }
  const name = options['--name'].trim();
  const projectId = options['--id'] || `project-${sha256(JSON.stringify({ name, sites })).slice(0, 12)}`;
  const port = Number(options['--port'] || 17373);
  if (!/^[a-z0-9-]{1,60}$/.test(projectId)) throw new Error('项目 ID 只能包含小写字母、数字、连字符，最长 60 字符');
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || sites.length > 30) throw new Error('端口或站点数量无效');
  const config = { port, projectId, name, sites };
  const directory = resolve(runtime, 'projects'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const configPath = resolve(directory, `${projectId}.json`);
  try { await writeFile(configPath, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (JSON.stringify(JSON.parse(await readFile(configPath, 'utf8'))) !== JSON.stringify(config)) throw new Error('此项目 ID 已有不同配置，请使用新 ID；原配置已保留');
  }
  return { configPath, project: config, next: `start ${projectId}` };
}
export async function listProjects(runtime) {
  const directory = resolve(runtime, 'projects');
  let entries;
  try { entries = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const file of entries.filter((name) => /^[a-z0-9-]+\.json$/.test(name)).sort()) {
    const configPath = resolve(directory, file);
    try { const { projectId, name, port, sites } = await loadConfig(configPath); result.push({ projectId, name, port, sites, configPath }); }
    catch (error) { result.push({ configPath, error: error.message }); }
  }
  return result;
}
export async function resolveProject(runtime, root, requested) {
  if (requested) {
    if (/^[a-z0-9-]{1,60}$/.test(requested)) {
      const path = resolve(runtime, 'projects', `${requested}.json`);
      try { await access(path); return path; } catch {}
    }
    return resolve(requested);
  }
  try { return JSON.parse(await readFile(resolve(runtime, 'current-project.json'), 'utf8')).configPath; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { const path = resolve(root, 'project.json'); await access(path); return path; } catch {}
  throw new Error('尚未初始化项目，请先运行 init --name 项目名 --url 页面地址');
}
