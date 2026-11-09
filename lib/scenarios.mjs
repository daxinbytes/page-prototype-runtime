import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { archive } from './trash.mjs';

export class Scenarios {
  constructor(store) { this.store = store; }
  get manifest() { return this.store.manifest; }
  get active() { return this.manifest?.scenarios?.find((item) => item.id === this.manifest.activeScenarioId); }
  list() {
    return (this.manifest?.scenarios || []).map(({ id, name, createdAt, updatedAt, selected, drafts }) => ({
      id, name, createdAt, updatedAt, active: id === this.manifest.activeScenarioId,
      selectedCount: selected.length, draftCount: Object.keys(drafts).length,
    }));
  }
  summary() { return this.list().find((item) => item.active) || null; }
  path(scenario, resource) { return resolve(this.store.directory, 'scenarios', scenario.id, 'overrides', `${resource.id}.${resource.type === 'Script' ? 'js' : 'css'}`); }
  validateName(value) {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name || name.length > 60 || /[\x00-\x1f]/.test(name)) throw new Error('方案名称须为 1–60 个字符');
    return name;
  }
  validateNew(name) {
    name = this.validateName(name);
    if (this.manifest.scenarios.length >= 50) throw new Error('当前项目最多保存 50 个方案');
    if (this.manifest.scenarios.some((item) => item.name === name)) throw new Error('已有同名方案，请换一个名称或继续已有方案');
    return name;
  }
  find(id) {
    const scenario = this.manifest?.scenarios?.find((item) => item.id === id);
    if (!scenario) throw new Error('当前项目中没有这个方案');
    return scenario;
  }
  projectActive() {
    const scenario = this.active;
    if (!scenario) {
      if (this.manifest.activeScenarioId) throw new Error('当前方案记录无效');
      this.manifest.selected = [];
      for (const resource of this.manifest.resources) delete resource.overridePath;
      return;
    }
    for (const resource of this.manifest.resources) {
      delete resource.overridePath;
      if (scenario.drafts[resource.id]) resource.overridePath = scenario.drafts[resource.id].path;
    }
    this.manifest.selected = [...scenario.selected];
  }
  async ensure() {
    if (!this.store.config.projectId) return;
    if (this.manifest.scenarios) { this.projectActive(); return; }
    if (this.store.config.managedProject && !this.manifest.resources.some(item => item.overridePath)) {
      this.manifest.scenarios = []; this.manifest.activeScenarioId = null; this.projectActive(); await this.store.save(); return;
    }
    const previous = JSON.stringify(this.manifest, null, 2);
    const legacy = this.manifest.resources.filter((item) => item.overridePath);
    if (legacy.length) {
      try { await writeFile(resolve(this.store.directory, 'manifest.pre-scenarios.json'), previous, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const now = new Date().toISOString();
    const scenario = { id: 's-initial', name: legacy.length ? '升级前的修改' : '方案 1', createdAt: now, updatedAt: now,
      selected: [...(this.manifest.selected || [])], drafts: {} };
    await mkdir(resolve(this.store.directory, 'scenarios', scenario.id, 'overrides'), { recursive: true, mode: 0o700 });
    for (const resource of legacy) {
      const destination = this.path(scenario, resource);
      // The old draft stays untouched; retrying an interrupted migration is safe.
      try { await copyFile(resource.overridePath, destination, 1); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!(await readFile(resource.overridePath)).equals(await readFile(destination))) throw new Error('方案迁移存在不同副本，已停止以保留原稿');
      }
      scenario.drafts[resource.id] = { path: destination, originalHash: resource.hash, url: resource.url };
    }
    this.manifest.scenarios = [scenario]; this.manifest.activeScenarioId = scenario.id;
    this.projectActive(); await this.store.save();
  }
  async create(name, target) {
    name = this.validateNew(name);
    const now = new Date().toISOString();
    const scenario = { id: `s-${randomUUID()}`, name, createdAt: now, updatedAt: now, selected: [], drafts: {} };
    await mkdir(resolve(this.store.directory, 'scenarios', scenario.id, 'overrides'), { recursive: true, mode: 0o700 });
    this.manifest.scenarios.push(scenario); this.manifest.activeScenarioId = scenario.id;
    this.manifest.editTarget = target || null; this.projectActive(); await this.store.save();
    return this.summary();
  }
  async use(id, target) {
    this.find(id); this.manifest.activeScenarioId = id;
    this.manifest.editTarget = target || null; this.projectActive(); await this.store.save(); return this.summary();
  }
  async rename(id, name) {
    const scenario = this.find(id); name = this.validateName(name);
    if (this.manifest.scenarios.some((item) => item.id !== id && item.name === name)) throw new Error('已有同名方案');
    scenario.name = name; scenario.updatedAt = new Date().toISOString(); await this.store.save();
    return this.list().find((item) => item.id === id);
  }
  async remove(id, runtimeRoot) {
    const scenario = this.find(id);
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('方案 ID 无效');
    const before = structuredClone(this.manifest), wasActive = this.manifest.activeScenarioId === id;
    const archived = await archive(runtimeRoot, 'scenario', { projectId: this.store.config.projectId, scenario }, [
      { path: relative(runtimeRoot, resolve(this.store.directory, 'scenarios', id)), name: 'scenario' },
    ]);
    this.manifest.scenarios = this.manifest.scenarios.filter(item => item.id !== id);
    if (wasActive) { this.manifest.activeScenarioId = null; this.manifest.editTarget = null; }
    this.projectActive();
    try { await this.store.save(); }
    catch (error) { this.store.manifest = before; await archived.rollback(); throw error; }
    return { id, name: scenario.name, wasActive, archiveDirectory: archived.directory };
  }
  async stage(items, selected) {
    const scenario = this.active;
    if (!scenario) throw new Error('请先创建或选择一个方案');
    for (const item of items) {
      let draft = scenario.drafts[item.id];
      if (!draft) {
        const path = this.path(scenario, item);
        try { await copyFile(item.path, path, 1); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (!(await readFile(item.path)).equals(await readFile(path))) throw new Error('发现未登记的不同草稿，已保留文件，请核对后继续');
        }
        draft = { path, originalHash: item.hash, url: item.url };
        scenario.drafts[item.id] = draft;
      }
    }
    scenario.selected = [...selected]; scenario.updatedAt = new Date().toISOString(); this.projectActive();
  }
}
