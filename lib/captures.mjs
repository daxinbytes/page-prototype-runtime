import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, projectInfo } from './workspace.mjs';
import { inspectJavaScript, inspectStylesheet, decodeInlineMap, mapSources } from './source-maps.mjs';
import { Scenarios } from './scenarios.mjs';

const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 100 * 1024 * 1024;
const shortHash = (text) => sha256(text).slice(0, 24);
const jsonWrite = async (path, value) => {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  const { rename } = await import('node:fs/promises'); await rename(tmp, path);
};

export class CaptureStore {
  constructor(root, config) { this.root = root; this.config = config; this.manifest = null; this.queue = Promise.resolve(); this.inspections = new Map(); this.decodedMaps = new Map(); this.scenarios = new Scenarios(this); }
  allows(origin) { return (this.config.sites || [{ origin: this.config.origin }]).some((site) => site.origin === origin); }
  run(operation) { const task = this.queue.then(operation); this.queue = task.catch(() => {}); return task; }
  async load() {
    if (this.config.projectId) {
      const id = `project-${this.config.projectId}`;
      this.directory = resolve(this.root, id);
      try { this.manifest = JSON.parse(await readFile(resolve(this.directory, 'manifest.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!this.manifest) { await this.begin(); await this.importLegacy(); }
      await this.scenarios.ensure();
      for (const site of this.manifest.sites || []) {
        if (!this.allows(site.origin)) this.config.sites.push(site);
      }
      this.manifest.editTarget = null;
      this.manifest.status = 'captured';
      await this.save();
      return;
    }
    try {
      const { id } = JSON.parse(await readFile(resolve(this.root, 'latest.json'), 'utf8'));
      if (!/^[a-zA-Z0-9-]+$/.test(id)) return;
      this.manifest = JSON.parse(await readFile(resolve(this.root, id, 'manifest.json'), 'utf8'));
      this.directory = resolve(this.root, id);
      if (this.manifest.origin !== this.config.origin || this.manifest.pagePath !== this.config.pagePath) {
        this.manifest = null; this.directory = undefined;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async begin() {
    if (this.config.projectId && this.manifest) { this.manifest.status = 'collecting'; await this.save(); return this.manifest.id; }
    const id = this.config.projectId ? `project-${this.config.projectId}` : `capture-${Date.now()}-${randomUUID().slice(0, 8)}`;
    this.directory = resolve(this.root, id);
    for (const folder of ['originals', 'maps', 'sources', 'overrides']) await mkdir(resolve(this.directory, folder), { recursive: true, mode: 0o700 });
    this.manifest = { id, createdAt: new Date().toISOString(), ...projectInfo(this.config),
      resources: [], maps: [], sources: [], selected: [], warnings: [], pages: [], imports: [],
      bytes: 0, sourceBytes: 0, reusedResources: 0, status: 'collecting' };
    await this.save(); await jsonWrite(resolve(this.root, 'latest.json'), { id }); return id;
  }
  async save() { await jsonWrite(resolve(this.directory, 'manifest.json'), this.manifest); }
  summary() {
    const m = this.manifest;
    return m ? { id: m.id, directory: this.directory, resources: m.resources.length, maps: m.maps.length,
      sources: m.sources.filter((s) => s.path).length, missingSources: m.sources.filter((s) => !s.path).length,
      projectName: this.config.name, pages: m.pages?.length || 0, reusedResources: m.reusedResources || 0,
      selected: m.selected, editTarget: m.editTarget || null, warnings: m.warnings.length + m.resources.reduce((count, item) => count + item.warnings.length, 0) + m.maps.filter((item) => item.status === 'error').length,
      activeScenario: this.scenarios.summary(), scenarios: this.scenarios.list(),
      status: m.status } : null;
  }
  async warn(message) {
    if (!this.manifest) return;
    if (this.manifest.warnings.length < 300) this.manifest.warnings.push(String(message).slice(0, 1000));
    await this.save();
  }
  async addMap(resource, map, ref, location) {
    const serialized = JSON.stringify(map);
    const mapHash = sha256(serialized);
    const id = `m-${shortHash(`${resource.id}|${ref}|${location}|${mapHash}`)}`;
    if (this.manifest.maps.some((item) => item.id === id)) return;
    const mapPath = resolve(this.directory, 'maps', `${mapHash}.map`);
    const newContent = !this.manifest.maps.some((item) => item.hash === mapHash);
    if (newContent && this.manifest.bytes + (this.manifest.mapBytes || 0) + Buffer.byteLength(serialized) > MAX_TOTAL) throw new Error('资源及映射总量超过 100 MB');
    if (newContent) this.manifest.mapBytes = (this.manifest.mapBytes || 0) + Buffer.byteLength(serialized);
    const record = { id, hash: mapHash, resourceId: resource.id, reference: ref.startsWith('data:') ? 'inline' : ref, location, path: mapPath, status: 'ok' };
    this.manifest.maps.push(record);
    try {
      let sources = this.decodedMaps.get(mapHash);
      if (!sources) { sources = mapSources(map); this.decodedMaps.set(mapHash, sources); }
      try { await writeFile(mapPath, JSON.stringify(map), { mode: 0o600, flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      for (const source of sources) {
        if (this.manifest.sources.length >= 10000) throw new Error('源码条目超过 10000 个');
        const hash = shortHash(`${source.label}|${source.content ?? 'missing'}`);
        const existing = this.manifest.sources.find((entry) => entry.id === hash);
        if (existing) {
          existing.resourceIds = [...new Set([...(existing.resourceIds || [existing.resourceId]), resource.id])];
          existing.mapIds = [...new Set([...(existing.mapIds || [existing.mapId]), id])];
          continue;
        }
        const name = basename(source.label.split('?')[0]).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-90) || 'source.txt';
        let path = null;
        if (source.content !== null) {
          const bytes = Buffer.byteLength(source.content);
          if (this.manifest.sourceBytes + bytes > MAX_TOTAL) throw new Error('提取源码总量超过 100 MB');
          const contentHash = sha256(source.content);
          const cached = this.manifest.sources.find((entry) => entry.contentHash === contentHash);
          path = cached?.path || resolve(this.directory, 'sources', `${contentHash.slice(0, 24)}-${name}`);
          if (!cached) { await writeFile(path, source.content, { mode: 0o600 }); this.manifest.sourceBytes += bytes; }
        }
        this.manifest.sources.push({ id: hash, resourceId: resource.id, resourceIds: [resource.id], mapId: id, mapIds: [id], label: source.label,
          contentHash: source.content === null ? null : sha256(source.content),
          path, lineCount: source.content === null ? 0 : source.content.split('\n').length,
          dependency: source.label.includes('node_modules/') });
      }
      if (sources.some((source) => source.content === null)) record.status = 'missing_sourcesContent';
    } catch (error) { record.status = 'error'; record.error = error.message; }
  }
  async ingest(metadata, bytes) {
    const m = this.manifest;
    if (!m || metadata.captureId !== m.id) throw new Error('采集会话已过期');
    const url = new URL(metadata.url);
    if (!this.allows(url.origin) || !['http:', 'https:'].includes(url.protocol)) throw new Error('资源不属于已授权站点');
    if (bytes.length > MAX_FILE) throw new Error('单文件超过 20 MB');
    if (metadata.kind === 'map') {
      const resource = m.resources.find((item) => item.id === metadata.resourceId);
      if (!resource || !resource.mapRequests?.some((item) => item.url === url.href)) throw new Error('map 未由资源引用');
      try { await this.addMap(resource, JSON.parse(bytes.toString('utf8')), url.href, 'external'); }
      catch (error) { m.warnings.push(`${url.href}: ${error.message}`); }
      await this.save(); return { neededMaps: [], capture: this.summary() };
    }
    if (!['Script', 'Stylesheet'].includes(metadata.type)) throw new Error('只采集 JS 和 CSS 资源');
    const hash = sha256(bytes);
    const id = `r-${shortHash(`${url.href}|${hash}`)}`;
    const previous = m.resources.find((item) => item.id === id);
    const changedHeader = previous && metadata.sourceMapHeader && metadata.sourceMapHeader !== previous.sourceMapHeader;
    if (previous && !changedHeader) { await this.recordPage(metadata, id); return { neededMaps: this.pendingMaps(previous), resourceId: id, capture: this.summary() }; }
    if (!bytes.length) return { neededMaps: [], skipped: 'empty', capture: this.summary() };
    if (m.resources.length >= 250) throw new Error('单次采集超过 250 个资源');
    const identical = m.resources.find((item) => item.hash === hash && item.type === metadata.type);
    if (!identical && m.bytes + (m.mapBytes || 0) + bytes.length > MAX_TOTAL) throw new Error('资源及映射总量超过 100 MB');
    const file = identical?.path || resolve(this.directory, 'originals', `${hash}.${metadata.type === 'Script' ? 'js' : 'css'}`);
    if (!identical) { await writeFile(file, bytes, { mode: 0o600 }); m.bytes += bytes.length; }
    else if (!previous) m.reusedResources = (m.reusedResources || 0) + 1;
    const resource = previous || { id, url: url.href, type: metadata.type, bytes: bytes.length, hash, path: file, mapRequests: [], warnings: [] };
    resource.sourceMapHeader = metadata.sourceMapHeader || resource.sourceMapHeader;
    if (!previous) m.resources.push(resource);
    const inspectionKey = `${hash}|${metadata.type}|${metadata.sourceMapHeader || ''}`;
    const inspection = this.inspections.get(inspectionKey) || (metadata.type === 'Script'
      ? inspectJavaScript(bytes.toString('utf8'), { header: metadata.sourceMapHeader })
      : inspectStylesheet(bytes.toString('utf8'), metadata.sourceMapHeader));
    this.inspections.set(inspectionKey, inspection);
    resource.warnings.push(...inspection.warnings);
    for (const entry of inspection.references) {
      try {
        if (entry.ref.startsWith('data:')) await this.addMap(resource, decodeInlineMap(entry.ref), entry.ref, entry.location);
        else {
          const mapUrl = new URL(entry.ref, url).href;
          if (!this.allows(new URL(mapUrl).origin)) throw new Error(`map 站点未加入项目：${mapUrl}`);
          if (!resource.mapRequests.some((item) => item.url === mapUrl)) resource.mapRequests.push({ url: mapUrl, resourceId: id });
        }
      } catch (error) { resource.warnings.push(error.message); }
    }
    if (!inspection.references.length) resource.warnings.push('未找到 source map 引用');
    await this.recordPage(metadata, id);
    await this.save(); return { neededMaps: this.pendingMaps(resource), resourceId: id, capture: this.summary() };
  }
  pendingMaps(resource) { return resource.mapRequests; }
  async recordPage(metadata, resourceId) {
    if (!metadata.pageUrl) return;
    const url = new URL(metadata.pageUrl);
    if (!this.allows(url.origin)) throw new Error('页面不属于当前项目');
    this.manifest.pages ||= [];
    let page = this.manifest.pages.find((entry) => entry.url === url.href);
    if (!page) {
      if (this.manifest.pages.length >= 200) return;
      page = { url: url.href, resourceIds: [] }; this.manifest.pages.push(page);
    }
    if (resourceId) page.resourceIds = [...new Set([...page.resourceIds, resourceId])];
    page.lastSeen = new Date().toISOString(); await this.save();
  }
  async probe(metadata) {
    if (metadata.captureId !== this.manifest?.id || !/^[a-f0-9]{64}$/.test(metadata.hash)) throw new Error('资源探测无效');
    if (!this.allows(new URL(metadata.url).origin)) throw new Error('资源站点未加入项目');
    const exact = this.manifest.resources.find((item) => item.url === metadata.url && item.hash === metadata.hash);
    if (exact && !(metadata.sourceMapHeader && metadata.sourceMapHeader !== exact.sourceMapHeader)) {
      await this.recordPage(metadata, exact.id); return { found: true, resourceId: exact.id, neededMaps: this.pendingMaps(exact), capture: this.summary() };
    }
    const same = this.manifest.resources.find((item) => item.hash === metadata.hash && item.type === metadata.type);
    if (!same) return { found: false };
    const bytes = await readFile(same.path);
    if (sha256(bytes) !== metadata.hash) throw new Error('缓存原始文件已被改动');
    return { found: true, ...await this.ingest(metadata, bytes) };
  }
  async addSite(site) {
    const url = new URL(site.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== site.origin) throw new Error('站点无效');
    if (!this.allows(url.origin)) this.config.sites.push({ origin: url.origin, pagePath: '/' });
    this.manifest.sites = this.config.sites; await this.save();
  }
  async importLegacy() {
    const entries = await readdir(this.root);
    for (const entry of entries.filter((name) => name.startsWith('capture-')).sort()) {
      const path = resolve(this.root, entry, 'manifest.json');
      let old;
      try { old = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
      if (!this.allows(old.origin)) continue;
      for (const item of old.resources) {
        try {
          const bytes = await readFile(item.path);
          if (sha256(bytes) !== item.hash) throw new Error('旧快照哈希不匹配');
          const result = await this.ingest({ captureId: this.manifest.id, url: item.url, type: item.type }, bytes);
          if (!result.resourceId) continue;
          for (const map of old.maps.filter((map) => map.resourceId === item.id && map.reference !== 'inline' && map.path)) {
            const parsed = JSON.parse(await readFile(map.path, 'utf8'));
            await this.addMap(this.manifest.resources.find((r) => r.id === result.resourceId), parsed, map.reference, 'external');
          }
          if (item.overridePath) {
            const draft = resolve(this.directory, 'overrides', `${result.resourceId}.${item.type === 'Script' ? 'js' : 'css'}`);
            try { await copyFile(item.overridePath, draft, 1); } catch (error) { if (error.code !== 'EEXIST') throw error; }
            this.manifest.resources.find((r) => r.id === result.resourceId).overridePath = draft;
          }
        } catch (error) { this.manifest.warnings.push(`历史导入 ${entry}: ${error.message}`); }
      }
      this.manifest.imports.push({ id: entry, path });
    }
    await this.save();
  }
  async stage(ids, { replace = false, target } = {}) {
    if (!this.manifest) throw new Error('请先采集原始页面');
    await this.scenarios.ensure();
    if (!ids?.length || ids.length > 20) throw new Error('请选择 1–20 个资源 ID');
    const items = ids.map((id) => this.manifest.resources.find((item) => item.id === id));
    if (items.some((item) => !item)) throw new Error('资源 ID 不存在');
    const selected = [...new Set([...(replace ? [] : this.manifest.selected), ...ids])];
    if (selected.length > 20) throw new Error('当前方案最多同时选中 20 个资源，请拆分为独立方案');
    const urls = selected.map((id) => this.manifest.resources.find((item) => item.id === id).url);
    if (new Set(urls).size !== urls.length) throw new Error('同一 URL 存在多个版本，请重新采集后选择');
    if (this.scenarios.active) await this.scenarios.stage(items, selected);
    else for (const item of items) {
      const path = item.overridePath || resolve(this.directory, 'overrides', `${item.id}.${item.type === 'Script' ? 'js' : 'css'}`);
      try { await copyFile(item.path, path, 1); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      item.overridePath = path;
    }
    this.manifest.selected = selected;
    if (target) this.manifest.editTarget = target;
    await this.save();
    return items.map(({ id, url, overridePath }) => ({ id, url, overridePath, scenarioId: this.manifest.activeScenarioId }));
  }
  async snapshot(revision) {
    if (!this.manifest?.selected.length) return null;
    const resources = [];
    for (const id of this.manifest.selected) {
      const item = this.manifest.resources.find((resource) => resource.id === id);
      const original = await readFile(item.path);
      if (sha256(original) !== item.hash) throw new Error('原始快照已被改动，请重新采集');
      const replacement = await readFile(item.overridePath);
      if (!replacement.length || replacement.length > MAX_FILE) throw new Error('覆盖文件为空或超过 20 MB');
      if (item.type === 'Script') inspectJavaScript(replacement.toString('utf8'), { validate: true });
      resources.push({ resourceUrl: item.url, type: item.type, originalHash: item.hash,
        overrideHash: sha256(replacement), body: replacement.toString('base64'), bytes: replacement.length });
    }
    return { ...projectInfo(this.config), revision, scenarioId: this.manifest.activeScenarioId, ...resources[0], resources };
  }
}
