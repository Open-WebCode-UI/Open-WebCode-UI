import express from 'express';
import { getDb } from '../db/index.js';
import { defineRoutes, fail, validate, z } from '../http.js';
import { audit } from '../audit.js';

// Badges are short labels an administrator attaches to models (data classification tier, what a model is good at, ...). Users see them in the
// model picker. Managed with the same permissions as the models themselves: provider.read to view, provider.write to change.
export const BADGE_COLORS = ['gray', 'blue', 'purple', 'teal', 'green', 'yellow', 'orange', 'red'];

export const badgesFor = (modelRowId) => getDb().prepare(`SELECT b.id, b.label, b.description, b.color, c.name category FROM model_badges mb JOIN badges b ON b.id=mb.badge_id
  LEFT JOIN badge_categories c ON c.id=b.category_id WHERE mb.model_id=? ORDER BY COALESCE(c.position, 1e9), c.id, b.position, b.id`).all(modelRowId);

const listAll = () => ({
  categories: getDb().prepare('SELECT id, name FROM badge_categories ORDER BY position, id').all(),
  badges: getDb().prepare('SELECT id, category_id categoryId, label, description, color FROM badges ORDER BY position, id').all(),
});

const categoryBody = z.object({ name: z.string().trim().min(1).max(60) });
const badgeBody = z.object({
  label: z.string().trim().min(1).max(40), description: z.string().trim().max(300).default(''), color: z.enum(BADGE_COLORS).default('gray'),
  categoryId: z.number().int().nullable().default(null),
});
const orderBody = z.object({ ids: z.array(z.number().int()).max(1000) });

export function badgesRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/api');
  const category = (id) => getDb().prepare('SELECT * FROM badge_categories WHERE id=?').get(id) || fail(404, 'not_found');
  const badge = (id) => getDb().prepare('SELECT * FROM badges WHERE id=?').get(id) || fail(404, 'not_found');
  const checkCategory = (id) => { if (id !== null) category(id); };
  // UNIQUE (category_id, label) doesn't cover NULL categories in SQLite, so uncategorized duplicates are checked here too.
  const checkUnique = (label, categoryId, exceptId) => {
    const dup = getDb().prepare('SELECT 1 FROM badges WHERE label=? AND category_id IS ? AND id IS NOT ?').get(label, categoryId, exceptId ?? null);
    if (dup) fail(409, 'badge_exists', { message: 'A badge with that name already exists in this category.' });
  };
  const reorder = (table, ids) => {
    const cur = getDb().prepare(`SELECT id FROM ${table}`).all().map((x) => x.id);
    if (ids.length !== cur.length || new Set(ids).size !== ids.length || !ids.every((i) => cur.includes(i))) fail(400, 'order_mismatch', { message: 'The list must contain every item exactly once.' });
    const set = getDb().prepare(`UPDATE ${table} SET position=? WHERE id=?`);
    getDb().transaction(() => ids.forEach((id, i) => set.run(i + 1, id)))();
  };

  route.get('/admin/badges', 'provider.read', (_req, res) => res.json(listAll()));

  route.post('/admin/badge-categories', 'provider.write', (req, res) => {
    const b = validate(categoryBody, req.body);
    if (getDb().prepare('SELECT 1 FROM badge_categories WHERE name=?').get(b.name)) fail(409, 'category_exists', { message: 'A category with that name already exists.' });
    const id = Number(getDb().prepare('INSERT INTO badge_categories (name, position) VALUES (?, (SELECT COALESCE(MAX(position),0)+1 FROM badge_categories))').run(b.name).lastInsertRowid);
    audit(req.user.id, 'badge.category.create', b.name);
    res.status(201).json(listAll().categories.find((c) => c.id === id));
  });
  // Registered before '/:id' so "order" is never read as an id.
  route.put('/admin/badge-categories/order', 'provider.write', (req, res) => {
    const { ids } = validate(orderBody, req.body);
    reorder('badge_categories', ids);
    audit(req.user.id, 'badge.category.reorder', null, { ids });
    res.json({ ok: true });
  });
  route.put('/admin/badge-categories/:id', 'provider.write', (req, res) => {
    const c = category(req.params.id), b = validate(categoryBody, req.body);
    if (getDb().prepare('SELECT 1 FROM badge_categories WHERE name=? AND id<>?').get(b.name, c.id)) fail(409, 'category_exists', { message: 'A category with that name already exists.' });
    getDb().prepare('UPDATE badge_categories SET name=? WHERE id=?').run(b.name, c.id);
    audit(req.user.id, 'badge.category.update', b.name, { was: c.name });
    res.json({ id: c.id, name: b.name });
  });
  // Badges in a deleted category are kept, uncategorized.
  route.delete('/admin/badge-categories/:id', 'provider.write', (req, res) => {
    const c = category(req.params.id);
    getDb().transaction(() => {
      // Moving into "uncategorized" must not collide with an existing uncategorized badge of the same name.
      const clash = getDb().prepare('SELECT b.label FROM badges b WHERE b.category_id=? AND EXISTS (SELECT 1 FROM badges o WHERE o.category_id IS NULL AND o.label=b.label)').get(c.id);
      if (clash) fail(409, 'badge_exists', { message: `Cannot delete: "${clash.label}" would duplicate an uncategorized badge. Rename or move it first.` });
      getDb().prepare('DELETE FROM badge_categories WHERE id=?').run(c.id);
    })();
    audit(req.user.id, 'badge.category.delete', c.name);
    res.json({ ok: true });
  });

  route.post('/admin/badges', 'provider.write', (req, res) => {
    const b = validate(badgeBody, req.body);
    checkCategory(b.categoryId); checkUnique(b.label, b.categoryId);
    const id = Number(getDb().prepare('INSERT INTO badges (category_id, label, description, color, position) VALUES (?,?,?,?, (SELECT COALESCE(MAX(position),0)+1 FROM badges))').run(b.categoryId, b.label, b.description, b.color).lastInsertRowid);
    audit(req.user.id, 'badge.create', b.label);
    res.status(201).json(listAll().badges.find((x) => x.id === id));
  });
  route.put('/admin/badges/order', 'provider.write', (req, res) => {
    const { ids } = validate(orderBody, req.body);
    reorder('badges', ids);
    audit(req.user.id, 'badge.reorder', null, { ids });
    res.json({ ok: true });
  });
  route.put('/admin/badges/:id', 'provider.write', (req, res) => {
    const old = badge(req.params.id), b = validate(badgeBody, req.body);
    checkCategory(b.categoryId); checkUnique(b.label, b.categoryId, old.id);
    getDb().prepare('UPDATE badges SET category_id=?, label=?, description=?, color=? WHERE id=?').run(b.categoryId, b.label, b.description, b.color, old.id);
    audit(req.user.id, 'badge.update', b.label, { was: old.label });
    res.json(listAll().badges.find((x) => x.id === old.id));
  });
  route.delete('/admin/badges/:id', 'provider.write', (req, res) => {
    const old = badge(req.params.id);
    getDb().prepare('DELETE FROM badges WHERE id=?').run(old.id); // removed from every model by the cascade
    audit(req.user.id, 'badge.delete', old.label);
    res.json({ ok: true });
  });

  // Replaces the set of badges on one model, and which one (if any) is featured on its card. The featured badge must be one of the model's
  // badges; when omitted, the current one is kept as long as it is still assigned.
  route.put('/admin/models/:id/badges', 'provider.write', (req, res) => {
    const m = getDb().prepare('SELECT m.id, m.model_id modelId, m.featured_badge_id featured, p.name provider FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=?').get(req.params.id) || fail(404, 'not_found');
    const { badgeIds, featuredBadgeId } = validate(z.object({ badgeIds: z.array(z.number().int()).max(100), featuredBadgeId: z.number().int().nullable().optional() }), req.body);
    const ids = [...new Set(badgeIds)];
    const known = new Set(getDb().prepare('SELECT id FROM badges').all().map((x) => x.id));
    if (!ids.every((i) => known.has(i))) fail(400, 'unknown_badge');
    if (featuredBadgeId != null && !ids.includes(featuredBadgeId)) fail(400, 'featured_not_assigned', { message: 'The featured badge must be one of the model\'s badges.' });
    const featured = featuredBadgeId === undefined ? (ids.includes(m.featured) ? m.featured : null) : featuredBadgeId;
    getDb().transaction(() => {
      getDb().prepare('DELETE FROM model_badges WHERE model_id=?').run(m.id);
      const ins = getDb().prepare('INSERT INTO model_badges (model_id, badge_id) VALUES (?,?)');
      for (const i of ids) ins.run(m.id, i);
      getDb().prepare('UPDATE models SET featured_badge_id=? WHERE id=?').run(featured, m.id);
    })();
    audit(req.user.id, 'provider.model.badges', m.provider, { model: m.modelId, badgeIds: ids, featuredBadgeId: featured });
    res.json({ badgeIds: ids, featuredBadgeId: featured });
  });
  return r;
}
