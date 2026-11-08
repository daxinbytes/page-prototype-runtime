import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export async function searchSources(manifest, query, { dependencies = false, limit = 40 } = {}) {
  if (!query) throw new Error('请提供要搜索的文字或代码');
  const needle = query.toLocaleLowerCase();
  const results = [], unreadable = [];
  let scanned = 0, missing = 0, truncated = false;
  for (const source of manifest.sources) {
    if (source.dependency && !dependencies) continue;
    if (!source.path) { missing++; continue; }
    let content;
    try { content = await readFile(source.path, 'utf8'); } catch { unreadable.push(source.id); continue; }
    scanned++;
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      const position = lines[index].toLocaleLowerCase().indexOf(needle);
      if (position === -1) continue;
      if (results.length === limit) { truncated = true; break; }
      const start = Math.max(0, position - 120);
      results.push({ sourceId: source.id, label: source.label, path: source.path, line: index + 1,
        snippet: lines[index].slice(start, start + 500), snippetTruncated: start > 0 || lines[index].length > start + 500,
        resourceIds: source.resourceIds || [source.resourceId] });
    }
    if (truncated) break;
  }
  return { query, scanned, missing, unreadable, truncated, results };
}

const hash = (text) => createHash('sha256').update(text).digest('hex');
export async function draftChanges(manifest) {
  const result = [];
  for (const id of manifest.selected || []) {
    const resource = manifest.resources.find((item) => item.id === id);
    if (!resource?.overridePath) throw new Error(`修改稿不存在：${id}`);
    const [before, after] = await Promise.all([readFile(resource.path, 'utf8'), readFile(resource.overridePath, 'utf8')]);
    let start = 0, end = 0;
    while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++;
    while (end < Math.min(before.length, after.length) - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
    const changed = before !== after;
    const beforeEnd = before.length - end, afterEnd = after.length - end;
    const excerpt = (text, finish) => text.slice(Math.max(0, start - 100), Math.min(text.length, finish + 100)).slice(0, 2000);
    result.push({ id, url: resource.url, type: resource.type, originalPath: resource.path, overridePath: resource.overridePath,
      changed, originalHash: hash(before), overrideHash: hash(after), originalBytes: Buffer.byteLength(before), overrideBytes: Buffer.byteLength(after),
      changeRegion: changed ? { line: before.slice(0, start).split('\n').length, before: excerpt(before, beforeEnd), after: excerpt(after, afterEnd),
        truncated: Math.max(beforeEnd - start, afterEnd - start) + 200 > 2000 } : null });
  }
  return { scenario: manifest.scenarios?.find((item) => item.id === manifest.activeScenarioId)?.name || null,
    scenarioId: manifest.activeScenarioId, target: manifest.editTarget || null, files: result,
    note: '这里展示首个到末个差异之间的摘要；完整差异请比较 originalPath 与 overridePath。' };
}
