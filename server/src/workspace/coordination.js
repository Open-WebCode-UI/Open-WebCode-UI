import crypto from 'node:crypto';

// Lets agent sessions that run at the same time in one project avoid overwriting each other.
//   - Claims: a session that changes a file holds it until its turn ends; others are refused (advisory: shell commands bypass it).
//   - Stamps: a hash of each file as this session last saw it (read or wrote), so a stale write_file/edit is refused.
//   - Awareness: a short note, rebuilt every step, naming the other running sessions, and the files they hold.
const projects = new Map(); // projectId -> Map(convId -> { title, files: Set<path> })

export const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

export function register(projectId, convId, title) {
  if (!projects.has(projectId)) projects.set(projectId, new Map());
  projects.get(projectId).set(convId, { title: title || `session ${convId}`, files: new Set() });
}
export function release(projectId, convId) {
  const m = projects.get(projectId); if (!m) return;
  m.delete(convId); if (!m.size) projects.delete(projectId);
}
export const others = (projectId, convId) => [...(projects.get(projectId) || [])].filter(([id]) => id !== convId).map(([id, s]) => ({ id, title: s.title, files: [...s.files] }));

// Returns null when the file is now (or already) held by this session, otherwise the title of the session that holds it.
export function claim(projectId, convId, rel) {
  const m = projects.get(projectId); if (!m || !m.has(convId)) return null;
  for (const [id, s] of m) if (id !== convId && s.files.has(rel)) return s.title;
  m.get(convId).files.add(rel);
  return null;
}

export function note(projectId, convId) {
  const o = others(projectId, convId); if (!o.length) return '';
  return `\n\n# Other agents running in this project right now\n${o.map((s) => `- "${s.title}"${s.files.length ? ` has changed: ${s.files.slice(0, 20).join(', ')}` : ' (no files changed yet)'}`).join('\n')}\nThese sessions edit the same project files at the same time. Avoid files they have changed; a write to one of them is refused until their turn ends. Re-read a file before editing it if it may have changed, and pick other work or tell the user if you are blocked.`;
}

// Per-turn view handed to the tools through ctx.coord.
export function forTurn(projectId, convId) {
  const stamps = new Map();
  return {
    stamp: (rel, content) => stamps.set(rel, hash(content)),
    // True when this session saw the file earlier and it has since been changed by someone else.
    stale: (rel, content) => stamps.has(rel) && stamps.get(rel) !== hash(content),
    claim: (rel) => claim(projectId, convId, rel),
    note: () => note(projectId, convId),
  };
}
