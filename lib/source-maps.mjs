import { parse } from 'acorn';

const MAX_MAPS = 2000;
const annotation = (text) => /(?:^|\s)[#@]\s*sourceMappingURL\s*=\s*(\S+)/.exec(text)?.[1];
function astOf(text, comments) {
  try { return parse(text, { ecmaVersion: 'latest', sourceType: 'script', onComment: comments }); }
  catch { comments.length = 0; return parse(text, { ecmaVersion: 'latest', sourceType: 'module', onComment: comments }); }
}

// Only parse string literals; downloaded application code is never evaluated here.
export function inspectJavaScript(text, { header, validate = false } = {}) {
  const references = [];
  const warnings = [];
  const visit = (source, location, depth) => {
    if (depth > 5 || references.length >= MAX_MAPS) throw new Error('嵌套代码或映射数量超过限制');
    const comments = [];
    let tree;
    try { tree = astOf(source, comments); }
    catch (error) {
      if (validate) throw new Error(`${location} 语法错误：${error.message}`);
      warnings.push(`${location} 无法解析：${error.message}`); return;
    }
    const urls = comments.map((comment) => annotation(comment.value)).filter(Boolean);
    const ref = location === 'bundle' && header ? header : urls.at(-1);
    if (ref) references.push({ ref, location });
    const stack = [tree];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (node.type === 'CallExpression' && node.callee?.name === 'eval' && node.arguments[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string') {
        visit(node.arguments[0].value, `${location}/eval@${node.start}`, depth + 1);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) stack.push(...value.filter((item) => item?.type));
        else if (value?.type) stack.push(value);
      }
    }
  };
  visit(text, 'bundle', 0);
  return { references, warnings };
}

export function inspectStylesheet(text, header) {
  const comments = [...text.matchAll(/\/\*([\s\S]*?)\*\//g)];
  const ref = header || comments.map((match) => annotation(match[1])).filter(Boolean).at(-1);
  return { references: ref ? [{ ref, location: 'stylesheet' }] : [], warnings: [] };
}

export function decodeInlineMap(ref) {
  const comma = ref.indexOf(',');
  if (!ref.startsWith('data:') || comma < 0) throw new Error('无效内联 map');
  const metadata = ref.slice(0, comma);
  const payload = ref.slice(comma + 1);
  const bytes = /;base64/i.test(metadata) ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload));
  if (bytes.length > 20 * 1024 * 1024) throw new Error('map 超过 20 MB');
  return JSON.parse(bytes.toString('utf8'));
}

export function mapSources(map, section = 'root', depth = 0) {
  if (depth > 5 || !map || map.version !== 3) throw new Error('不支持的 source map 格式');
  if (Array.isArray(map.sections)) {
    return map.sections.flatMap((entry, index) => {
      if (!entry.map) throw new Error('当前不支持 sections.url，需内嵌 section map');
      return mapSources(entry.map, `${section}/${index}`, depth + 1);
    });
  }
  if (!Array.isArray(map.sources) || map.sources.length > 10000) throw new Error('map 的 sources 无效或数量过多');
  return map.sources.map((name, index) => ({
    label: `${map.sourceRoot || ''}${map.sourceRoot && !map.sourceRoot.endsWith('/') ? '/' : ''}${name || '(unnamed)'}`,
    content: typeof map.sourcesContent?.[index] === 'string' ? map.sourcesContent[index] : null,
    section, index,
  }));
}
