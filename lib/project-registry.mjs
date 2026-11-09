import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listProjects } from './project-configs.mjs';
import { loadConfig } from './workspace.mjs';
import { httpURL, pageKey, scopeForPage, matchesScope } from '../extension/page-identity.js';
import { archive } from './trash.mjs';

const writeJSON = async (path, value) => {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(tmp, path);
};
export class ProjectRegistry {
  constructor(root, port = 17373) { this.root = root; this.port = port; this.cache = []; }
  path(id) {
    if (!/^[a-z0-9-]{1,60}$/.test(id || '')) throw new Error('项目 ID 无效');
    return resolve(this.root, 'projects', `${id}.json`);
  }
  async refresh() { this.cache = await listProjects(this.root); return this.cache; }
  async create(name) {
    name = typeof name === 'string' ? name.trim() : '';
    if (!name || name.length > 60 || /[\x00-\x1f]/.test(name)) throw new Error('项目名称须为 1–60 个字符');
    await this.refresh();
    if (this.cache.some(item => item.name === name)) throw new Error('已有同名项目，请选择已有项目或使用其他名称');
    const projectId = `p-${randomUUID()}`;
    await mkdir(resolve(this.root, 'projects'), { recursive: true, mode: 0o700 });
    await writeJSON(this.path(projectId), { projectId, name, port: this.port, managedProject: true, sites: [], pageRules: [], savedPages: [] });
    await this.refresh(); return projectId;
  }
  async load(id) {
    const path = this.path(id), raw = JSON.parse(await readFile(path, 'utf8'));
    if (!raw.managedProject) {
      // Preserve old captures/drafts, but never reuse the old whole-domain rule
      // as automatic page ownership. Historical pages require an explicit join.
      let manifest;
      try { manifest = JSON.parse(await readFile(resolve(this.root, 'captures', `project-${id}`, 'manifest.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      raw.managedProject = true; raw.pageRules = []; raw.savedPages = [];
      for (const item of manifest?.pages || []) {
        try {
          const key = pageKey(item.url);
          if (!raw.savedPages.some(page => page.key === key)) raw.savedPages.push({ key, url: item.url, title: item.title || '', lastSeen: item.lastSeen, needsReview: true });
        } catch { /* Keep malformed historical evidence in the original manifest. */ }
      }
      await writeJSON(path, raw);
    }
    return loadConfig(path);
  }
  async save(config) {
    const { projectId, name, port, sites, pageRules = [], savedPages = [], excludedPageKeys = [] } = config;
    await writeJSON(this.path(projectId), { projectId, name, port, managedProject: true, sites, pageRules, savedPages, excludedPageKeys });
    await this.refresh();
  }
  async attach(config, { url, title = '' }) {
    const parsed = httpURL(url), rule = config.pageRules?.find(item => matchesScope(item, url)) || scopeForPage(url);
    if (!config.sites.some(site => site.origin === parsed.origin)) {
      if (config.sites.length >= 30) throw new Error('当前项目最多支持 30 个站点');
      config.sites.push({ origin: parsed.origin, pagePath: rule.pagePath });
    }
    config.pageRules ||= [];
    if (!config.pageRules.some(item => JSON.stringify(item) === JSON.stringify(rule))) config.pageRules.push(rule);
    config.excludedPageKeys = (config.excludedPageKeys || []).filter(key => key !== pageKey(url));
    await this.remember(config, { url, title }, true);
  }
  async remember(config, { url, title = '' }, approved = false) {
    const key = pageKey(url); config.savedPages ||= [];
    if (config.excludedPageKeys?.includes(key)) throw new Error('页面已从项目移出，需手动接入后才能继续采集');
    let page = config.savedPages.find(item => item.key === key);
    if (!page) {
      if (config.savedPages.length >= 200) throw new Error('当前项目最多保存 200 类页面');
      page = { key, url, title: '', needsReview: !approved }; config.savedPages.push(page);
    }
    page.url = url; if (title) page.title = String(title).slice(0, 200);
    page.lastSeen = new Date().toISOString(); if (approved) page.needsReview = false;
    await this.save(config);
  }
  async removePage(config, key) {
    const page = config.savedPages?.find(item => item.key === key);
    if (!page) throw new Error('当前项目中没有这个页面');
    const previous = { savedPages: config.savedPages, excludedPageKeys: config.excludedPageKeys || [] };
    const archived = await archive(this.root, 'page', { projectId: config.projectId, page });
    config.savedPages = config.savedPages.filter(item => item.key !== key);
    config.excludedPageKeys = [...new Set([...previous.excludedPageKeys, key])];
    try { await this.save(config); }
    catch (error) { Object.assign(config, previous); await archived.rollback(); throw error; }
    return { key, title: page.title, archiveDirectory: archived.directory };
  }
  async remove(id) {
    const config = JSON.parse(await readFile(this.path(id), 'utf8'));
    if (config.projectId !== id) throw new Error('项目记录与 ID 不一致');
    const archived = await archive(this.root, 'project', { projectId: id, name: config.name }, [
      { path: `projects/${id}.json`, name: 'project.json' },
      { path: `captures/project-${id}`, name: 'capture', optional: true },
    ]);
    try { await this.refresh(); }
    catch (error) { await archived.rollback(); throw error; }
    return { projectId: id, name: config.name, archiveDirectory: archived.directory };
  }
}
