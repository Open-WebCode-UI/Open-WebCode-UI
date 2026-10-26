import { describe, it, expect } from 'vitest';
import { freshDb, createApp, login } from './helpers.js';

const setup = async () => {
  await freshDb(); const app = createApp();
  const admin = await login(app, { username: 'adm', roles: ['administrator'] }), dev = await login(app, { username: 'dev1', roles: ['developer'] });
  const p = (await admin.post('/api/admin/providers').send({ name: 'Acme', type: 'openai', secret: 'k' })).body.id;
  const m = (await admin.post(`/api/admin/providers/${p}/models`).send({ modelId: 'm1' })).body.models[0].id;
  return { admin, dev, p, m };
};

describe('badges', () => {
  it('creates, renames, reorders and deletes categories and badges', async () => {
    const { admin } = await setup();
    const tier = (await admin.post('/api/admin/badge-categories').send({ name: ' Data tier ' })).body;
    expect(tier.name).toBe('Data tier');
    expect((await admin.post('/api/admin/badge-categories').send({ name: 'Data tier' })).status).toBe(409);
    const task = (await admin.post('/api/admin/badge-categories').send({ name: 'Good at' })).body;
    expect((await admin.put(`/api/admin/badge-categories/${task.id}`).send({ name: 'Strengths' })).body.name).toBe('Strengths');
    const t2 = (await admin.post('/api/admin/badges').send({ label: 'Tier 2', color: 'orange', categoryId: tier.id, description: 'Approved for internal data.' })).body;
    expect(t2).toMatchObject({ label: 'Tier 2', color: 'orange', categoryId: tier.id, description: 'Approved for internal data.' });
    expect((await admin.post('/api/admin/badges').send({ label: 'Tier 2', categoryId: tier.id })).status).toBe(409);
    expect((await admin.post('/api/admin/badges').send({ label: 'Tier 2', categoryId: task.id })).status).toBe(201); // same name, other category
    expect((await admin.post('/api/admin/badges').send({ label: 'x', color: 'hotpink' })).status).toBe(400);
    expect((await admin.post('/api/admin/badges').send({ label: 'x', categoryId: 999 })).status).toBe(404);
    expect((await admin.put(`/api/admin/badges/${t2.id}`).send({ label: 'Tier 2+', color: 'green', categoryId: tier.id })).body).toMatchObject({ label: 'Tier 2+', color: 'green', description: '' });
    const all = (await admin.get('/api/admin/badges')).body;
    expect(all.categories.map((c) => c.name)).toEqual(['Data tier', 'Strengths']);
    expect((await admin.put('/api/admin/badge-categories/order').send({ ids: [task.id, tier.id] })).status).toBe(200);
    expect((await admin.put('/api/admin/badge-categories/order').send({ ids: [task.id] })).status).toBe(400);
    expect((await admin.get('/api/admin/badges')).body.categories.map((c) => c.name)).toEqual(['Strengths', 'Data tier']);
    // deleting a category keeps its badges, uncategorized
    expect((await admin.del(`/api/admin/badge-categories/${tier.id}`)).status).toBe(200);
    expect((await admin.get('/api/admin/badges')).body.badges.find((b) => b.id === t2.id).categoryId).toBeNull();
    expect((await admin.del(`/api/admin/badges/${t2.id}`)).status).toBe(200);
    expect((await admin.del(`/api/admin/badges/${t2.id}`)).status).toBe(404);
  });

  it('refuses to uncategorize a badge into a name clash', async () => {
    const { admin } = await setup();
    const c = (await admin.post('/api/admin/badge-categories').send({ name: 'C' })).body;
    await admin.post('/api/admin/badges').send({ label: 'Same' });
    await admin.post('/api/admin/badges').send({ label: 'Same', categoryId: c.id });
    expect((await admin.post('/api/admin/badges').send({ label: 'Same' })).status).toBe(409); // uncategorized duplicates are caught too
    expect((await admin.del(`/api/admin/badge-categories/${c.id}`)).status).toBe(409);
    expect((await admin.get('/api/admin/badges')).body.categories).toHaveLength(1);
  });

  it('assigns badges to a model and shows them, in category order, to users', async () => {
    const { admin, dev, p, m } = await setup();
    const tier = (await admin.post('/api/admin/badge-categories').send({ name: 'Data tier' })).body;
    const good = (await admin.post('/api/admin/badge-categories').send({ name: 'Good at' })).body;
    const coding = (await admin.post('/api/admin/badges').send({ label: 'Coding', categoryId: good.id })).body;
    const t3 = (await admin.post('/api/admin/badges').send({ label: 'Tier 3', color: 'red', categoryId: tier.id })).body;
    const loose = (await admin.post('/api/admin/badges').send({ label: 'New' })).body;
    expect((await admin.put(`/api/admin/models/${m}/badges`).send({ badgeIds: [loose.id, coding.id, t3.id, t3.id] })).body.badgeIds).toEqual([loose.id, coding.id, t3.id]);
    expect((await admin.get('/api/admin/providers')).body.find((x) => x.id === p).models[0].badgeIds.sort()).toEqual([coding.id, t3.id, loose.id].sort());
    expect((await dev.get('/api/models')).body.models[0].badges).toEqual([
      { id: t3.id, label: 'Tier 3', description: '', color: 'red', category: 'Data tier' },
      { id: coding.id, label: 'Coding', description: '', color: 'gray', category: 'Good at' },
      { id: loose.id, label: 'New', description: '', color: 'gray', category: null },
    ]);
    expect((await admin.put(`/api/admin/models/${m}/badges`).send({ badgeIds: [9999] })).status).toBe(400);
    expect((await admin.put('/api/admin/models/9999/badges').send({ badgeIds: [] })).status).toBe(404);
    // deleting a badge removes it from models; clearing works
    await admin.del(`/api/admin/badges/${coding.id}`);
    expect((await dev.get('/api/models')).body.models[0].badges.map((b) => b.label)).toEqual(['Tier 3', 'New']);
    await admin.put(`/api/admin/models/${m}/badges`).send({ badgeIds: [] });
    expect((await dev.get('/api/models')).body.models[0].badges).toEqual([]);
  });

  it('features at most one badge per model, and only one the model already has', async () => {
    const { admin, dev, p, m } = await setup();
    const a = (await admin.post('/api/admin/badges').send({ label: 'A' })).body, b = (await admin.post('/api/admin/badges').send({ label: 'B' })).body;
    const url = `/api/admin/models/${m}/badges`, featured = async () => (await dev.get('/api/models')).body.models[0].featuredBadgeId;
    expect(await featured()).toBeNull();
    expect((await admin.put(url).send({ badgeIds: [a.id], featuredBadgeId: b.id })).status).toBe(400); // b is not assigned
    expect((await admin.put(url).send({ badgeIds: [], featuredBadgeId: a.id })).status).toBe(400);
    expect((await admin.put(url).send({ badgeIds: [a.id, b.id], featuredBadgeId: [a.id, b.id] })).status).toBe(400); // one only
    expect((await admin.put(url).send({ badgeIds: [a.id, b.id], featuredBadgeId: b.id })).body).toMatchObject({ featuredBadgeId: b.id });
    expect(await featured()).toBe(b.id);
    expect((await admin.get('/api/admin/providers')).body.find((x) => x.id === p).models[0].featuredBadgeId).toBe(b.id);
    expect((await admin.put(url).send({ badgeIds: [a.id, b.id] })).body.featuredBadgeId).toBe(b.id); // omitted: kept while still assigned
    expect((await admin.put(url).send({ badgeIds: [a.id] })).body.featuredBadgeId).toBeNull(); // unassigned: cleared
    await admin.put(url).send({ badgeIds: [a.id, b.id], featuredBadgeId: a.id });
    expect((await admin.put(url).send({ badgeIds: [a.id, b.id], featuredBadgeId: null })).body.featuredBadgeId).toBeNull(); // explicit clear
    await admin.put(url).send({ badgeIds: [a.id, b.id], featuredBadgeId: a.id });
    await admin.del(`/api/admin/badges/${a.id}`); // deleting the badge un-features it
    expect(await featured()).toBeNull();
  });

  it('is limited to people who can manage models', async () => {
    const { admin, dev } = await setup();
    const b = (await admin.post('/api/admin/badges').send({ label: 'B' })).body;
    for (const r of [dev.get('/api/admin/badges'), dev.post('/api/admin/badges').send({ label: 'x' }), dev.put(`/api/admin/badges/${b.id}`).send({ label: 'x' }), dev.del(`/api/admin/badges/${b.id}`),
      dev.post('/api/admin/badge-categories').send({ name: 'x' }), dev.put('/api/admin/models/1/badges').send({ badgeIds: [] })]) expect((await r).status).toBe(403);
  });
});
