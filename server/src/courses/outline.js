import { getKnex } from '../db/index.js';
import { trx } from '../db/dialect.js';

// A course is an outline of top-level items: pages and modules, in one shared order. A module holds pages (one level only).
// Both tables keep a `position`: top-level pages and modules are ordered together; a module's pages are ordered within it.
// The learner's reading order is the outline flattened, so a module's pages follow each other in the place the module sits.

export async function loadOutline(courseId) {
  const k = getKnex();
  const modules = await k('course_modules').where({ course_id: courseId }).select('id', 'title', 'position');
  const rows = await k('course_pages').where({ course_id: courseId }).orderBy([{ column: 'position' }, { column: 'id' }]);
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

// The next free position at the top level, or inside a module. `t` is a transaction when the caller is in one.
export async function nextPosition(courseId, moduleId = null, t = getKnex()) {
  if (moduleId != null) return ((await t('course_pages').where({ course_id: courseId, module_id: moduleId }).max({ m: 'position' }).first()).m ?? -1) + 1;
  const a = (await t('course_pages').where({ course_id: courseId }).whereNull('module_id').max({ m: 'position' }).first()).m ?? -1;
  const b = (await t('course_modules').where({ course_id: courseId }).max({ m: 'position' }).first()).m ?? -1;
  return Math.max(a, b) + 1;
}

export const moduleBelongsTo = async (courseId, moduleId) => !!(await getKnex()('course_modules').where({ id: moduleId, course_id: courseId }).first('id'));

// Rewrite the whole structure from [{type:'page',id} | {type:'module',id,pages:[ids]}]. It must name every page and module of the
// course exactly once, so a stale client cannot drop or duplicate anything. Returns false when it does not match.
export async function applyOutline(courseId, items) {
  const { pages } = await loadOutline(courseId);
  const mods = (await getKnex()('course_modules').where({ course_id: courseId }).select('id')).map((m) => m.id);
  const seenPages = items.flatMap((i) => (i.type === 'page' ? [i.id] : i.pages || []));
  const seenMods = items.filter((i) => i.type === 'module').map((i) => i.id);
  const same = (a, b) => a.length === b.length && new Set(a).size === a.length && [...a].sort((x, y) => x - y).every((v, k) => v === [...b].sort((x, y) => x - y)[k]);
  if (!same(seenPages, pages.map((p) => p.id)) || !same(seenMods, mods)) return false;
  await trx(getKnex(), async (t) => {
    for (const [n, i] of items.entries()) {
      if (i.type === 'page') await t('course_pages').where({ id: i.id }).update({ position: n, module_id: null });
      else {
        await t('course_modules').where({ id: i.id }).update({ position: n });
        for (const [k, pid] of (i.pages || []).entries()) await t('course_pages').where({ id: pid }).update({ position: k, module_id: i.id });
      }
    }
  });
  return true;
}

// The outline as plain items, for editing it (move a page, remove a module) and handing back to applyOutline.
export async function outlineItems(courseId) { return (await loadOutline(courseId)).outline.map((i) => ({ ...i, ...(i.pages ? { pages: [...i.pages] } : {}) })); }
