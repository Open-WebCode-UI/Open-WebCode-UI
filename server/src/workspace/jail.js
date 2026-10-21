import fs from 'node:fs';
import path from 'node:path';

export class JailError extends Error { constructor(m) { super(m); this.name = 'JailError'; } }

// True when `p` is `root` or inside it. path.relative is separator- and drive-aware, so a path on another drive is rejected.
const within = (root, p) => { const r = path.relative(root, p); return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r)); };

// Resolve a user/agent-supplied relative path inside `root`. Rejects absolute paths, traversal,
// NUL bytes, and symlink escapes (checked against the realpath of the deepest existing ancestor).
export function resolveInJail(root, rel) {
  if (typeof rel !== 'string') throw new JailError('Path must be a string');
  if (rel.includes('\0')) throw new JailError('Invalid path');
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new JailError('Absolute paths are not allowed');
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, rel);
  if (!within(realRoot, target)) throw new JailError('Path escapes the project');
  let probe = target;
  while (!fs.existsSync(probe) && !isLink(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let real;
  try { real = fs.realpathSync(probe); } catch { throw new JailError('Broken symlink'); }
  if (!within(realRoot, real)) throw new JailError('Symlink escapes the project');
  return target;
}
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

// Paths inside a repository's metadata directory. Its config/hooks name programs git runs, so it is never writable through
// the file APIs or the agent's file tools. Case-insensitive (macOS/Windows file systems) and covers Windows 8.3 short names.
export const isGitPath = (rel) => String(rel).split(/[\\/]+/).some((s) => { const l = s.trim().toLowerCase().replace(/[. ]+$/, ''); return l === '.git' || /^git~\d+$/.test(l); });
// resolveInJail for operations that modify files: additionally refuses anything under .git.
export function resolveForWrite(root, rel) {
  const abs = resolveInJail(root, rel);
  if (isGitPath(path.relative(fs.realpathSync(root), abs))) throw new JailError('The .git directory cannot be modified here');
  return abs;
}

export const relFrom = (root, abs) => path.relative(fs.realpathSync(root), abs).split(path.sep).join('/');

export function globToRegex(g) {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`(^|/)${esc}$`);
}
export const isSecretPath = (rel, globs) => globs.some((g) => globToRegex(g).test(rel));
