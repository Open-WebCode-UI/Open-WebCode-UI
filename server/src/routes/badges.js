import express from 'express';
import { getKnex } from '../db/index.js';
import { trx } from '../db/dialect.js';
import { insertId } from '../db/dialect.js';
import { defineRoutes, fail, validate, z } from '../http.js';
import { audit } from '../audit.js';

// Badges are short labels an administrator attaches to models (data classification tier, what a model is good at, ...). Users see them in the
// model picker. Managed with the same permissions as the models themselves: provider.read to view, provider.write to change.
export const BADGE_COLORS = ['gray', 'blue', 'purple', 'teal', 'green', 'yellow', 'orange', 'red'];

export const badgesFor = (modelRowId) => getKnex()('model_badges as mb').join('badges as b', 'b.id', 'mb.badge_id').leftJoin('badge_categories as c', 'c.id', 'b.category_id')
  .where('mb.model_id', modelRowId).orderByRaw('COALESCE(c.position, 1000000000), c.id, b.position, b.id')
  .select('b.id', 'b.label', 'b.description', 'b.color', 'c.name as category');

const listAll = async () => ({
  categories: await getKnex()('badge_categories').select('id', 'name').orderBy([{ column: 'position' }, { column: 'id' }]),
  badges: await getKnex()('badges').select('id', 'category_id as categoryId', 'label', 'description', 'color').orderBy([{ column: 'position' }, { column: 'id' }]),
});

// The next display position in a table: one past the highest.
const nextPosition = async (q) => ((await q.max({ m: 'position' }).first()).m ?? 0) + 1;

const categoryBody = z.object({ name: z.string().trim().min(1).max(60) });
const badgeBody = z.object({
  label: z.string().trim().min(1).max(40), description: z.string().trim().max(300).default(''), color: z.enum(BADGE_COLORS).default('gray'),
  categoryId: z.number().int().nullable().default(null),
});
const orderBody = z.object({ ids: z.array(z.number().int()).max(1000) });

const idOf = (v) => { const n = Number(v); return Number.isInteger(n) ? n : fail(404, 'not_found'); };

export function badgesRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/api');
  const category = async (id) => (await getKnex()('badge_categories').where({ id: idOf(id) }).first()) || fail(404, 'not_found');
  const badge = async (id) => (await getKnex()('badges').where({ id: idOf(id) }).first()) || fail(404, 'not_found');
  const checkCategory = async (id) => { if (id !== null) await category(id); };
  // UNIQUE (category_id, label) doesn't cover NULL categories, so uncategorized duplicates are checked here too.
  const checkUnique = async (label, categoryId, exceptId) => {
    const dup = await getKnex()('badges').where({ label })
      .modify((q) => (categoryId == null ? q.whereNull('category_id') : q.where('category_id', categoryId)))
      .modify((q) => { if (exceptId != null) q.whereNot('id', exceptId); }).first('id');
    if (dup) fail(409, 'badge_exists', { message: 'A badge with that name already exists in this category.' });
  };
  const reorder = async (table, ids) => {
    const cur = (await getKnex()(table).select('id')).map((x) => x.id);
    if (ids.length !== cur.length || new Set(ids).size !== ids.length || !ids.every((i) => cur.includes(i))) fail(400, 'order_mismatch', { message: 'The list must contain every item exactly once.' });
    await trx(getKnex(), async (t) => { for (const [i, id] of ids.entries()) await t(table).where({ id }).update({ position: i + 1 }); });
  };

  route.get('/admin/badges', 'provider.read', async (_req, res) => res.json(await listAll()));

  route.post('/admin/badge-categories', 'provider.write', async (req, res) => {
    const b = validate(categoryBody, req.body);
    if (await getKnex()('badge_categories').where({ name: b.name }).first('id')) fail(409, 'category_exists', { message: 'A category with that name already exists.' });
    const id = await trx(getKnex(), async (t) => insertId(t('badge_categories'), { name: b.name, position: await nextPosition(t('badge_categories')) }));
    await audit(req.user.id, 'badge.category.create', b.name);
    res.status(201).json((await listAll()).categories.find((c) => c.id === id));
  });
  // Registered before '/:id' so "order" is never read as an id.
  route.put('/admin/badge-categories/order', 'provider.write', async (req, res) => {
    const { ids } = validate(orderBody, req.body);
    await reorder('badge_categories', ids);
    await audit(req.user.id, 'badge.category.reorder', null, { ids });
    res.json({ ok: true });
  });
  route.put('/admin/badge-categories/:id', 'provider.write', async (req, res) => {
    const c = await category(req.params.id), b = validate(categoryBody, req.body);
    if (await getKnex()('badge_categories').where({ name: b.name }).whereNot({ id: c.id }).first('id')) fail(409, 'category_exists', { message: 'A category with that name already exists.' });
    await getKnex()('badge_categories').where({ id: c.id }).update({ name: b.name });
    await audit(req.user.id, 'badge.category.update', b.name, { was: c.name });
    res.json({ id: c.id, name: b.name });
  });
  // Badges in a deleted category are kept, uncategorized.
  route.delete('/admin/badge-categories/:id', 'provider.write', async (req, res) => {
    const c = await category(req.params.id);
    await trx(getKnex(), async (t) => {
      // Moving into "uncategorized" must not collide with an existing uncategorized badge of the same name.
      const clash = await t('badges as b').where('b.category_id', c.id)
        .whereExists(function () { this.select(t.raw('1')).from('badges as o').whereNull('o.category_id').whereRaw('o.label = b.label'); }).first('b.label');
      if (clash) fail(409, 'badge_exists', { message: `Cannot delete: "${clash.label}" would duplicate an uncategorized badge. Rename or move it first.` });
      await t('badge_categories').where({ id: c.id }).del();
    });
    await audit(req.user.id, 'badge.category.delete', c.name);
    res.json({ ok: true });
  });

  route.post('/admin/badges', 'provider.write', async (req, res) => {
    const b = validate(badgeBody, req.body);
    await checkCategory(b.categoryId); await checkUnique(b.label, b.categoryId);
    const id = await trx(getKnex(), async (t) => insertId(t('badges'), { category_id: b.categoryId, label: b.label, description: b.description, color: b.color, position: await nextPosition(t('badges')) }));
    await audit(req.user.id, 'badge.create', b.label);
    res.status(201).json((await listAll()).badges.find((x) => x.id === id));
  });
  route.put('/admin/badges/order', 'provider.write', async (req, res) => {
    const { ids } = validate(orderBody, req.body);
    await reorder('badges', ids);
    await audit(req.user.id, 'badge.reorder', null, { ids });
    res.json({ ok: true });
  });
  route.put('/admin/badges/:id', 'provider.write', async (req, res) => {
    const old = await badge(req.params.id), b = validate(badgeBody, req.body);
    await checkCategory(b.categoryId); await checkUnique(b.label, b.categoryId, old.id);
    await getKnex()('badges').where({ id: old.id }).update({ category_id: b.categoryId, label: b.label, description: b.description, color: b.color });
    await audit(req.user.id, 'badge.update', b.label, { was: old.label });
    res.json((await listAll()).badges.find((x) => x.id === old.id));
  });
  route.delete('/admin/badges/:id', 'provider.write', async (req, res) => {
    const old = await badge(req.params.id);
    await getKnex()('badges').where({ id: old.id }).del(); // removed from every model by the cascade
    await audit(req.user.id, 'badge.delete', old.label);
    res.json({ ok: true });
  });

  // Replaces the set of badges on one model, and which one (if any) is featured on its card. The featured badge must be one of the model's
  // badges; when omitted, the current one is kept as long as it is still assigned.
  route.put('/admin/models/:id/badges', 'provider.write', async (req, res) => {
    const m = (await getKnex()('models as m').join('providers as p', 'p.id', 'm.provider_id').where('m.id', idOf(req.params.id))
      .first('m.id', 'm.model_id as modelId', 'm.featured_badge_id as featured', 'p.name as provider')) || fail(404, 'not_found');
    const { badgeIds, featuredBadgeId } = validate(z.object({ badgeIds: z.array(z.number().int()).max(100), featuredBadgeId: z.number().int().nullable().optional() }), req.body);
    const ids = [...new Set(badgeIds)];
    const known = new Set((await getKnex()('badges').select('id')).map((x) => x.id));
    if (!ids.every((i) => known.has(i))) fail(400, 'unknown_badge');
    if (featuredBadgeId != null && !ids.includes(featuredBadgeId)) fail(400, 'featured_not_assigned', { message: 'The featured badge must be one of the model\'s badges.' });
    const featured = featuredBadgeId === undefined ? (ids.includes(m.featured) ? m.featured : null) : featuredBadgeId;
    await trx(getKnex(), async (t) => {
      await t('model_badges').where({ model_id: m.id }).del();
      if (ids.length) await t('model_badges').insert(ids.map((i) => ({ model_id: m.id, badge_id: i })));
      await t('models').where({ id: m.id }).update({ featured_badge_id: featured });
    });
    await audit(req.user.id, 'provider.model.badges', m.provider, { model: m.modelId, badgeIds: ids, featuredBadgeId: featured });
    res.json({ badgeIds: ids, featuredBadgeId: featured });
  });
  return r;
}
