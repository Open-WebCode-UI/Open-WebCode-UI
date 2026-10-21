import { getDb } from '../db/index.js';

// A course is an outline of top-level items: pages and modules, in one shared order. A module holds pages (one level only).
// Both tables keep a `position`: top-level pages and modules are ordered together; a module's pages are ordered within it.
// The learner's reading order is the outline flattened, so a module's pages follow each other in the place the module sits.

export function loadOutline(courseId) {
  const db = getDb();
  const modules = db.prepare('SELECT id, title, position FROM course_modules WHERE course_id=?').all(courseId);
  const rows = db.prepare('SELECT * FROM course_pages WHERE course_id=? ORDER BY position, id').all(courseId);
  const inModule = new Map(modules.map((m) => [m.id, []]));
  const top = rows.filter((p) => p.module_id == null || !inModule.has(p.module_id));
  for (const p of rows) if (p.module_id != null && inModule.has(p.module_id)) inModule.get(p.module_id).push(p);
  const items = [
    ...top.map((p) => ({ type: 'page', position: p.position, id: p.id, row: p })),
    ...modules.map((m) => ({ type: 'module', position: m.position, id: m.id, title: m.title, rows: inModule.get(m.id) })),
  ].sort((a, b) => a.position - b.position || (a.type === b.type ? a.id - b.id : a.type === 'page' ? -1 : 1));
  const pages = items.flatMap((i) => (i.type === 'page' ? [i.row] : i.rows));
  const outline = items.map((i) => (i.type === 'page' ? { type: 'page', id: i.id } : { type: 'module', id: i.id, title: i.title, pages: i.rows.map((p) => p.id) }));
  return { pages, outline };
}

// The next free position at the top level, or inside a module.
export function nextPosition(courseId, moduleId = null) {
  const db = getDb();
  if (moduleId != null) return (db.prepare('SELECT MAX(position) m FROM course_pages WHERE course_id=? AND module_id=?').get(courseId, moduleId).m ?? -1) + 1;
  const a = db.prepare('SELECT MAX(position) m FROM course_pages WHERE course_id=? AND module_id IS NULL').get(courseId).m ?? -1;
  const b = db.prepare('SELECT MAX(position) m FROM course_modules WHERE course_id=?').get(courseId).m ?? -1;
  return Math.max(a, b) + 1;
}

export const moduleBelongsTo = (courseId, moduleId) => !!getDb().prepare('SELECT 1 FROM course_modules WHERE id=? AND course_id=?').get(moduleId, courseId);

// Rewrite the whole structure from [{type:'page',id} | {type:'module',id,pages:[ids]}]. It must name every page and module of the
// course exactly once, so a stale client cannot drop or duplicate anything. Returns false when it does not match.
export function applyOutline(courseId, items) {
  const db = getDb(), { pages } = loadOutline(courseId);
  const mods = db.prepare('SELECT id FROM course_modules WHERE course_id=?').all(courseId).map((m) => m.id);
  const seenPages = items.flatMap((i) => (i.type === 'page' ? [i.id] : i.pages || []));
  const seenMods = items.filter((i) => i.type === 'module').map((i) => i.id);
  const same = (a, b) => a.length === b.length && new Set(a).size === a.length && [...a].sort((x, y) => x - y).every((v, k) => v === [...b].sort((x, y) => x - y)[k]);
  if (!same(seenPages, pages.map((p) => p.id)) || !same(seenMods, mods)) return false;
  const setPage = db.prepare('UPDATE course_pages SET position=?, module_id=? WHERE id=?'), setMod = db.prepare('UPDATE course_modules SET position=? WHERE id=?');
  db.transaction(() => items.forEach((i, n) => {
    if (i.type === 'page') setPage.run(n, null, i.id);
    else { setMod.run(n, i.id); (i.pages || []).forEach((pid, k) => setPage.run(k, i.id, pid)); }
  }))();
  return true;
}

// The outline as plain items, for editing it (move a page, remove a module) and handing back to applyOutline.
export function outlineItems(courseId) { return loadOutline(courseId).outline.map((i) => ({ ...i, ...(i.pages ? { pages: [...i.pages] } : {}) })); }
