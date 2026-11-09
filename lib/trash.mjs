import { mkdir, writeFile, rename, lstat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

// Deletion removes an item from the working set. Its files stay recoverable.
// The caller can roll back the moves if writing its catalogue fails.
export async function archive(root, kind, metadata, entries = []) {
  root = resolve(root);
  const directory = resolve(root, 'trash', `${kind}-${Date.now()}-${randomUUID()}`);
  const moves = [];
  for (const entry of entries) {
    const from = resolve(root, entry.path);
    if (!from.startsWith(`${root}${sep}`) || !/^[a-zA-Z0-9._-]+$/.test(entry.name)) throw new Error('回收路径无效');
    try { await lstat(from); }
    catch (error) { if (entry.optional && error.code === 'ENOENT') continue; throw error; }
    moves.push({ from, to: resolve(directory, entry.name) });
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const moved = [];
  async function rollback() {
    for (const item of [...moved].reverse()) await rename(item.to, item.from);
    moved.length = 0;
    await writeFile(resolve(directory, 'record.json'), JSON.stringify({ kind, ...metadata, status: 'rolled-back', moves }, null, 2), { mode: 0o600 });
  }
  try {
    for (const item of moves) { await rename(item.from, item.to); moved.push(item); }
    await writeFile(resolve(directory, 'record.json'), JSON.stringify({ kind, ...metadata, createdAt: new Date().toISOString(), status: 'archived', moves }, null, 2), { mode: 0o600 });
  } catch (error) { await rollback(); throw error; }
  return { directory, rollback };
}
