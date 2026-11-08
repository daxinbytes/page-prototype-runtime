import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createBridge } from './lib/bridge.mjs';
import { loadConfig } from './lib/workspace.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(process.argv[2] || `${root}/config.json`);
const runtime = resolve(process.env.BRIDGE_RUNTIME_DIR || `${root}/.runtime`);
await mkdir(runtime, { recursive: true, mode: 0o700 });
await chmod(runtime, 0o700);
let token;
try { token = (await readFile(`${runtime}/token`, 'utf8')).trim(); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  token = randomBytes(32).toString('base64url');
  await writeFile(`${runtime}/token`, token, { mode: 0o600, flag: 'wx' });
}
await chmod(`${runtime}/token`, 0o600);
const config = await loadConfig(configPath);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await bridge.close();
  process.exit(0);
};
const bridge = await createBridge({ config, token, captureRoot: `${runtime}/captures`, onShutdown: stop });
await new Promise((resolve, reject) => {
  bridge.server.once('error', reject);
  bridge.server.listen(config.port, '127.0.0.1', resolve);
});
await writeFile(`${runtime}/connection.json`, JSON.stringify({
  port: config.port, pid: process.pid, configPath,
}, null, 2), { mode: 0o600 });
console.log(`本地服务已启动：http://127.0.0.1:${config.port}`);
console.log('运行 npm run pair 获取配对码；运行 npm run status 查看连接状态。');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
