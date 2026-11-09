import { pageKey } from './extension/page-identity.js';
import { readFile, mkdir, open, writeFile, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createClient, verifyApplication } from './lib/client.mjs';
import { initializeProject, listProjects, resolveProject } from './lib/project-configs.mjs';
import { searchSources, draftChanges } from './lib/inspection.mjs';
import { loadConfig } from './lib/workspace.mjs';
import { installationHome } from './lib/installation-home.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const runtime = resolve(process.env.BRIDGE_RUNTIME_DIR || `${root}/.runtime`);
const action = process.argv[2] || 'status';
const args = process.argv.slice(3);
const call = createClient(runtime);
const output = (value) => console.log(JSON.stringify(value, null, 2));
const version = JSON.parse(await readFile(`${root}/package.json`, 'utf8')).version;
const help = `页面原型 ${version} · 本地页面分析与预览

初始化与连接：
  init --name 项目名 --url 页面地址 [--url 另一个地址] [--id 项目ID] [--path 路径] [--port 端口]
  projects                          只读列出已保存项目和页面
  project use 项目ID                 切换项目，恢复旧预览并保留所有资料
  project delete 项目ID              删除项目及其本地资料，移入回收目录
  page remove 页面地址 [--project 项目ID] 从当前项目移出页面，保留资源和方案
  start [项目ID或配置文件] [--port 端口] 启动服务；不指定项目时等待面板选择
  doctor                            诊断连接和采集状态，不输出配对码
  pair                              在本机显示配对码，填入扩展
  status                            完整状态（JSON）

采集与分析：
  capture [标签页ID]                 开始或继续项目采集
  inspect                           当前页面、导航、资源、缺失项的上下文
  resources [关键词]                查找已加载资源
  sources [关键词]                  查找源码文件名
  search [--dependencies] 关键词    搜索源码内容，返回行号及所属资源

制作与预览：
  scenarios                         列出当前项目已保存的方案
  scenario new 名称 [--tab 标签页ID]  基于原始页面 新建独立方案
  scenario use 方案ID [--tab 标签页ID] 恢复原页并切换到已有方案
  scenario rename 方案ID 新名称       重命名方案
  scenario delete 方案ID [--project 项目ID] 删除方案，保留原始资源
  stage --project 项目ID --scenario 方案ID --tab 标签页ID 资源ID...      准备修改稿并绑定页面
  changes                           查看当前修改摘要
  apply [--project 项目ID] [--scenario 方案ID]          应用到已绑定页面，并等待资源替换结果
  restore [标签页ID]                停用修改，保留采集
  target 标签页ID                   显式重新绑定修改目标
  join 标签页ID                     加入已在扩展中授权的新站点
  end                               结束项目协作，保留资料
  stop                              停止本地服务

数据目录：${runtime}
切换项目：使用面板项目下拉框或 project use 项目ID，无需重启服务。网页显示和交互仍需实际验收。`;
const tabArgument = (value) => {
  if (value === undefined) return undefined;
  const id = Number(value);
  if (!Number.isInteger(id) || id < 0) throw new Error('标签页 ID 必须是非负整数');
  return id;
};
const takeOption = (name) => {
  const index = args.indexOf(name); if (index === -1) return undefined;
  const value = args[index + 1]; if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数`);
  args.splice(index, 2); return value;
};
async function capture() {
  const result = await call('/capture');
  if (!result.manifest) throw new Error('尚未采集页面，请先在扩展中开始项目协作');
  return result;
}
try {
  if (['help', '--help', '-h'].includes(action)) console.log(help);
  else if (['version', '--version'].includes(action)) console.log(version);
  else if (action === 'init') output(await initializeProject(runtime, args));
  else if (action === 'projects') output(await listProjects(runtime));
  else if (action === 'project' && args[0] === 'use' && args[1]) output(await call('/command', { action: 'project-use', projectId: args[1] }));
  else if (action === 'project' && args[0] === 'delete' && args.length === 2) {
    const state = await call('/status');
    output(await call('/command', { action: 'project-delete', projectId: args[1], expectedProjectId: state.workspace?.selectedProjectId }));
  }
  else if (action === 'page') {
    const expectedProjectId = takeOption('--project');
    if (args[0] !== 'remove' || args.length !== 2) throw new Error('用法：page remove 页面地址 [--project 项目ID]');
    const state = await call('/status');
    output(await call('/command', { action: 'page-remove', key: pageKey(args[1]), expectedProjectId: expectedProjectId || state.workspace?.selectedProjectId }));
  }
  else if (action === 'scenarios') output(await call('/scenarios'));
  else if (action === 'scenario') {
    const requestedProjectId = takeOption('--project');
    const tabId = tabArgument(takeOption('--tab'));
    const subcommand = args.shift();
    const state = await call('/status');
    const expectedScenarioId = state.capture?.activeScenario?.id;
    const expectedProjectId = requestedProjectId || state.workspace?.selectedProjectId;
    if (subcommand === 'new') output(await call('/command', { action: 'scenario-new', name: args.join(' '), tabId, expectedScenarioId, expectedProjectId }));
    else if (subcommand === 'use' && args.length === 1) output(await call('/command', { action: 'scenario-use', scenarioId: args[0], tabId, expectedScenarioId, expectedProjectId }));
    else if (subcommand === 'delete' && args.length === 1) output(await call('/command', { action: 'scenario-delete', scenarioId: args[0], expectedProjectId, expectedScenarioId }));
    else if (subcommand === 'rename' && args.length >= 2) output(await call('/command', { action: 'scenario-rename', scenarioId: args.shift(), name: args.join(' ') }));
    else throw new Error('用法：scenarios | scenario new 名称 [--tab ID] | scenario use 方案ID [--tab ID] | scenario rename 方案ID 新名称 | scenario delete 方案ID');
  }
  else if (action === 'start') {
    const port = Number(takeOption('--port') || 17373);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('服务端口无效');
    const configPath = args[0] ? await resolveProject(runtime, root, args[0]) : null;
    const requested = configPath ? await loadConfig(configPath) : null;
    try {
      const existing = JSON.parse(await readFile(`${runtime}/connection.json`, 'utf8'));
      const state = await call('/status');
      if (configPath && state.workspace) {
        if (state.workspace.selectedProjectId !== requested.projectId) await call('/command', { action: 'project-use', projectId: requested.projectId });
      } else if (configPath && existing.configPath !== configPath) throw new Error('已有服务使用其他配置，请先 end、stop');
      output({ running: true, configPath, runtime }); process.exit(0);
    } catch (error) { if (error.message.includes('其他配置')) throw error; }
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    const log = await open(`${runtime}/service.log`, 'a', 0o600);
    const child = spawn(process.execPath, [`${root}/server.mjs`, configPath || '--idle', String(port)], {
      detached: true, cwd: root, stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, BRIDGE_RUNTIME_DIR: runtime },
    });
    let exited = false;
    child.on('exit', () => { exited = true; }); child.on('error', () => { exited = true; });
    child.unref(); await log.close();
    let ready = false;
    for (let attempt = 0; attempt < 240 && !exited; attempt++) {
      await new Promise((done) => setTimeout(done, 150));
      try {
        await call('/status');
        const connection = JSON.parse(await readFile(`${runtime}/connection.json`, 'utf8'));
        if (connection.pid === child.pid) { ready = true; break; }
      } catch {}
    }
    if (!ready) throw new Error(`启动失败，请查看 ${runtime}/service.log`);
    if (configPath) await writeFile(`${runtime}/current-project.json`, JSON.stringify({ configPath }), { mode: 0o600 });
    output({ running: true, configPath, runtime, next: '首次使用请运行 pair，将配对码填入扩展；已有配对无需重复。' });
  } else if (action === 'doctor') {
    let status, problem;
    try { status = await call('/status'); } catch (error) { problem = error.message; }
    const checks = [
      { name: 'Node.js', ok: Number(process.versions.node.split('.')[0]) >= 20, detail: process.version },
      { name: '本地服务', ok: Boolean(status), detail: problem || '正在运行' },
      { name: '浏览器扩展', ok: Boolean(status?.connected), detail: status?.connected ? `已连接 ${status.extension?.version || ''}` : '在扩展中连接服务' },
      { name: '项目协作', ok: Boolean(status?.extension?.active), detail: status?.extension?.active ? `跟随 ${status.extension.trackedTabs.length} 个标签页` : '在扩展中开始项目协作' },
    ];
    let extensionDirectory = `${root}/extension`;
    try {
      const installed = JSON.parse(await readFile(resolve(await installationHome(), 'installation.json'), 'utf8'));
      if (await realpath(installed.tool) === await realpath(resolve(root, 'bin/page-prototype.mjs'))) extensionDirectory = installed.extension;
    } catch {}
    output({ version, runtime, extensionDirectory, ready: checks.every((check) => check.ok), checks, capture: status?.capture || null });
  } else if (action === 'pair') {
    await call('/status'); console.log((await readFile(`${runtime}/token`, 'utf8')).trim());
  } else if (action === 'status') output(await call('/status'));
  else if (action === 'stop') output(await call('/shutdown', {}));
  else if (action === 'apply') {
    const expected = takeOption('--scenario');
    const expectedProjectId = takeOption('--project');
    const state = await call('/status');
    if (!state.extension?.capabilities?.includes('verified-apply')) throw new Error('请先重新加载 0.4 或更新版本的扩展，再开始项目协作');
    const applied = await call('/command', { action, tabId: tabArgument(args[0]), expectedScenarioId: expected || state.capture?.activeScenario?.id, expectedProjectId: expectedProjectId || state.workspace?.selectedProjectId });
    const result = await verifyApplication(call, { tabId: applied.result.tabId, revision: applied.result.revision,
      expectedURLs: applied.resource.resources.map((item) => item.resourceUrl) });
    output({ ...result, scenario: applied.capture?.activeScenario, target: applied.result.binding, note: '全部选中资源已替换；页面视觉和交互需另行验收。' });
  } else if (['restore', 'capture', 'end', 'target', 'join'].includes(action)) {
    output(await call('/command', { action, tabId: tabArgument(args[0]) }));
  } else if (['resources', 'sources'].includes(action)) {
    const data = await capture();
    const query = args.join(' ').toLowerCase();
    const all = data.manifest[action].filter((item) => JSON.stringify(item).toLowerCase().includes(query));
    output({ directory: data.directory, total: all.length, results: all.slice(0, 80), truncated: all.length > 80, manifest: `${data.directory}/manifest.json` });
  } else if (action === 'search') {
    const dependencies = args[0] === '--dependencies';
    output(await searchSources((await capture()).manifest, (dependencies ? args.slice(1) : args).join(' '), { dependencies }));
  } else if (action === 'inspect') {
    const state = await call('/status');
    const data = await capture(), m = data.manifest;
    const warnings = [...m.warnings, ...m.resources.flatMap((r) => r.warnings.map((warning) => `${r.url}: ${warning}`)),
      ...m.maps.filter((map) => map.status === 'error').map((map) => map.error)];
    output({ project: state.extension?.project || state.resource, connected: state.connected,
      active: Boolean(state.extension?.active), tabs: state.extension?.trackedTabs || [], recentPages: state.extension?.recentPages || [],
      pendingSites: state.extension?.pendingSites || [], target: m.editTarget || null, capture: state.capture,
      activeScenario: state.capture?.activeScenario, scenarios: state.capture?.scenarios,
      pages: (m.pages || []).slice(-20), warnings: warnings.slice(-20), warningsTruncated: warnings.length > 20,
      directory: data.directory, manifest: `${data.directory}/manifest.json`,
      limits: ['采集页面实际加载的 JS/CSS 与可获得的 source map', '源码索引用于分析，提取的源文件不会自动编译', '尚未采集接口响应、表单输入和点击轨迹'] });
  } else if (action === 'changes') output(await draftChanges((await capture()).manifest));
  else if (action === 'stage') {
    const tabId = tabArgument(takeOption('--tab'));
    const expectedScenarioId = takeOption('--scenario');
    const expectedProjectId = takeOption('--project');
    if (!args.length) throw new Error('stage 至少需要一个资源 ID');
    output(await call('/command', { action, tabId, resourceIds: args, expectedScenarioId, expectedProjectId }));
  } else throw new Error('未知命令，运行 --help 查看用法');
} catch (error) { console.error(error.message); process.exitCode = 1; }
