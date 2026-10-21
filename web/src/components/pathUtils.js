// Project paths are POSIX-style and relative to the project root ('' is the root).
export const baseName = (p) => p.split('/').pop();
export const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);
export const isWithin = (p, dir) => p === dir || p.startsWith(`${dir}/`);

// Re-points an open file path after `from` (a file or a folder) was renamed or moved to `to`.
export function remap(p, from, to) { return p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p; }

// Files from a drop. Folders dragged from the desktop are walked (webkitGetAsEntry) so their structure is preserved.
export async function filesFromDrop(dt) {
  const items = [...(dt.items || [])].filter((i) => i.kind === 'file');
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])].map((file) => ({ file, rel: file.name }));
  const out = [];
  const readAll = (reader) => new Promise((res, rej) => { const all = []; const next = () => reader.readEntries((b) => (b.length ? (all.push(...b), next()) : res(all)), rej); next(); });
  const walk = async (entry, prefix) => {
    if (entry.isFile) await new Promise((res, rej) => entry.file((file) => { out.push({ file, rel: prefix + entry.name }); res(); }, rej));
    else if (entry.isDirectory) for (const child of await readAll(entry.createReader())) await walk(child, `${prefix}${entry.name}/`);
  };
  for (const e of entries) await walk(e, '');
  return out;
}

// Adds files that are still being written (not on disk yet) to a tree, creating missing folders, so the Explorer can show them early.
export function withPending(tree, paths) {
  const out = JSON.parse(JSON.stringify(tree || []));
  for (const p of paths) {
    let level = out, prefix = '';
    const parts = p.split('/').filter(Boolean);
    parts.forEach((name, i) => {
      prefix = prefix ? `${prefix}/${name}` : name;
      const last = i === parts.length - 1;
      let node = level.find((n) => n.name === name);
      if (!node) { node = last ? { name, path: prefix, type: 'file', pending: true } : { name, path: prefix, type: 'dir', children: [], pending: true }; level.push(node); }
      if (!last && node.type === 'dir') level = node.children;
    });
  }
  return out;
}
