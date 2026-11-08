import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function loadConfig(file) {
  const config = JSON.parse(await readFile(file, 'utf8'));
  const sites = (config.sites || [{ origin: config.origin, pagePath: config.pagePath }]).map((site) => {
    const url = new URL(site.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('站点地址无效');
    if (typeof site.pagePath !== 'string' || !site.pagePath.startsWith('/')) throw new Error('站点路径无效');
    return { origin: url.origin, pagePath: site.pagePath };
  });
  if (!sites.length || sites.length > 30) throw new Error('项目站点数量无效');
  if (config.projectId && !/^[a-z0-9-]{1,60}$/.test(config.projectId)) throw new Error('projectId 格式无效');
  const { origin, pagePath } = sites[0];
  const resource = config.resourceUrl ? new URL(config.resourceUrl) : null;
  if (resource && (resource.origin !== origin || !['http:', 'https:'].includes(resource.protocol))) {
    throw new Error('资源 URL 必须属于指定站点');
  }
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error('端口必须位于 1024–65535');
  }
  return {
    ...config, origin, pagePath, sites, directory: dirname(resolve(file)), resourceUrl: resource?.href,
    originalFile: resource ? resolve(dirname(file), config.originalFile) : undefined,
    overrideFile: resource ? resolve(dirname(file), config.overrideFile) : undefined,
  };
}

// Only parse syntax. Never execute the downloaded business bundle on the service.
export async function readSnapshot(config, revision) {
  if (!config.resourceUrl) return { ...projectInfo(config), revision, resources: [] };
  const [original, replacement] = await Promise.all([
    readFile(config.originalFile), readFile(config.overrideFile),
  ]);
  if (!original.length || !replacement.length || replacement.length > 5 * 1024 * 1024) {
    throw new Error('原始文件或覆盖文件为空，或覆盖文件超过 5 MB');
  }
  new Script(replacement.toString('utf8'), { filename: 'override.js' });
  return {
    ...projectInfo(config),
    resourceUrl: config.resourceUrl, revision,
    originalHash: sha256(original), overrideHash: sha256(replacement),
    body: replacement.toString('base64'), bytes: replacement.length,
  };
}

export const projectInfo = (config) => ({ origin: config.origin, pagePath: config.pagePath,
  projectId: config.projectId, projectName: config.name || '页面协作',
  sites: config.sites || [{ origin: config.origin, pagePath: config.pagePath }] });

export function publicSnapshot(snapshot) {
  const { body, ...metadata } = snapshot;
  if (metadata.resources) metadata.resources = metadata.resources.map(({ body, ...item }) => item);
  return metadata;
}
