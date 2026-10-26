import { loadSettings } from '../src/settings.js';
import { getKnex } from '../src/db/index.js';

const upsertGeneral = (value) => getKnex()('settings').insert({ key: 'general', value }).onConflict('key').merge();
import { sqlDb } from './db-sql.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, login, makeRole, addProvider, fakeAdapterFactory } from './helpers.js';

import { costOf } from '../src/usage.js';

const drain = (r) => r.buffer(true).parse((res, cb) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => cb(null, d)); });

describe('usage, cost, and reports', () => {
  let app, u, project, modelId;
  const turn = (body = {}) => drain(u.post('/api/agent/turn').send({ message: 'hi', mode: 'plan', modelId, projectId: project.id, ...body }));
  beforeEach(async () => {
    await freshDb(); modelId = await addProvider();
    (await sqlDb().prepare('UPDATE models SET input_price=3, output_price=15 WHERE id=?').run(modelId));
    app = createApp({ deps: { adapterFactory: fakeAdapterFactory([[{ type: 'text', text: 'ok' }, { type: 'usage', inputTokens: 1000, outputTokens: 200 }]]) } });
    u = await login(app, { username: 'costuser1' });
    project = (await u.post('/api/projects').send({ name: 'cp' })).body;
  });

  it('prices are USD per million tokens', () => { expect(costOf(1000, 200, { input_price: 3, output_price: 15 })).toBeCloseTo(0.006); expect(costOf(10, 10, {})).toBe(0); });

  it('records each model request and hides the cost from users unless an administrator turns it on', async () => {
    await turn();
    const row = (await sqlDb().prepare('SELECT * FROM usage').get());
    expect(row).toMatchObject({ input_tokens: 1000, output_tokens: 200, estimated: 0, kind: 'agent', model_row_id: modelId });
    expect(row.cost).toBeCloseTo(0.006);
    expect((await u.get(`/api/sessions?projectId=${project.id}`)).body[0]).not.toHaveProperty('cost');
    const s = sqlDb(); (await s.prepare("INSERT INTO settings (key,value) VALUES ('general', ?)").run(JSON.stringify({ showSessionCost: true }))); await loadSettings();
    const [sess] = (await u.get(`/api/sessions?projectId=${project.id}`)).body;
    expect(sess.cost).toBeCloseTo(0.006); expect(sess.modelId).toBe(modelId);
    expect((await u.get(`/api/sessions/${sess.id}`)).body.modelId).toBe(modelId);
  });

  it('shows chats their token estimate and cost only when an administrator turns it on', async () => {
    const c = await login(app, { username: 'chatcost1' });
    await drain(c.post('/api/chat/turn').send({ chatType: 'coding', message: 'hi', modelId }));
    const list = async () => (await c.get('/api/conversations?kind=chat&chatType=coding')).body[0];
    expect(await list()).not.toHaveProperty('cost'); expect(await list()).not.toHaveProperty('tokens');
    (await upsertGeneral(JSON.stringify({ showSessionCost: true }))); await loadSettings();
    const shown = await list(); expect(shown.cost).toBeCloseTo(0.006); expect(shown.tokens).toBeGreaterThan(0);
  });

  it('lets a permission show a user their own spend without the global switch, and leaves the reports alone', async () => {
    await turn();
    await makeRole('spender', ['project.read', 'project.write', 'files.read', 'agent.plan', 'provider.use', 'spend.view']);
    const s = await login(app, { username: 'spender1', roles: ['spender'] });
    const p = (await s.post('/api/projects').send({ name: 'sp' })).body;
    await drain(s.post('/api/agent/turn').send({ message: 'hi', mode: 'plan', modelId, projectId: p.id }));
    const cost = async (who, pr) => (await who.get(`/api/sessions?projectId=${pr.id}`)).body[0];
    expect((await cost(s, p)).cost).toBeCloseTo(0.006); // permission holder sees it with the global switch off
    expect(await cost(u, project)).not.toHaveProperty('cost'); // everyone else still does not
    expect((await s.get('/api/reports/usage')).status).toBe(403); // and the permission grants no report access
    (await sqlDb().prepare("INSERT INTO settings (key,value) VALUES ('general', ?)").run(JSON.stringify({ showSessionCost: true }))); await loadSettings();
    expect((await cost(u, project)).cost).toBeCloseTo(0.006); // the global switch still shows it to all
  });

  it('reports group by model ID, not the friendly name, and keep each request at the price in force when it ran', async () => {
    await turn(); // 1000 in / 200 out at $3 / $15 = $0.006
    (await sqlDb().prepare("UPDATE models SET label='Renamed', input_price=6, output_price=30 WHERE id=?").run(modelId));
    await turn(); // same tokens at the new prices = $0.012
    await makeRole('finance2', ['report.read']);
    const rep = await login(app, { username: 'reporter2', roles: ['finance2'] });
    const r = (await rep.get('/api/reports/usage')).body;
    expect(r.byModel).toHaveLength(1); // the rename did not split the model
    expect(r.byModel[0]).toMatchObject({ model: 'fake-model', requests: 2 });
    expect(r.totals.cost).toBeCloseTo(0.018); // not 2 x 0.012 (repriced history) and not 2 x 0.006
    const costs = (await sqlDb().prepare('SELECT cost FROM usage ORDER BY id').all()).map((x) => x.cost);
    expect(costs[0]).toBeCloseTo(0.006); expect(costs[1]).toBeCloseTo(0.012);
  });

  it('falls back to an estimate (flagged) when the provider reports no usage', async () => {
    app = createApp({ deps: { adapterFactory: fakeAdapterFactory([[{ type: 'text', text: 'x'.repeat(400) }]]) } });
    u = await login(app, { username: 'costuser2' }); project = (await u.post('/api/projects').send({ name: 'cp2' })).body;
    await turn();
    expect((await sqlDb().prepare('SELECT estimated, output_tokens o FROM usage').get())).toMatchObject({ estimated: 1, o: 100 });
  });

  it('reports spend by model, only for roles with report.read', async () => {
    await turn();
    const dev = await u.get('/api/reports/usage'); expect(dev.status).toBe(403);
    await makeRole('finance', ['report.read']);
    const rep = await login(app, { username: 'reporter1', roles: ['finance'] });
    const r = (await rep.get('/api/reports/usage')).body;
    expect(r.byModel).toHaveLength(1);
    expect(r.byModel[0]).toMatchObject({ model: 'fake-model', requests: 1, inputTokens: 1000, outputTokens: 200 });
    expect(r.totals.cost).toBeCloseTo(0.006);
    expect(r.byUser).toHaveLength(1); expect(r.byUser[0]).toMatchObject({ username: 'costuser1', requests: 1, models: 'fake-model' }); expect(r.byUser[0].cost).toBeCloseTo(0.006);
    expect((await rep.get('/api/reports/usage?from=4102444800')).body.byModel).toEqual([]);
    expect((await rep.get('/api/reports/usage?from=abc')).status).toBe(400);
  });

  it('administrators can set model prices; the built-in reporter role exists', async () => {
    const admin = await login(app, { username: 'adm1', roles: ['administrator'] });
    const pid = (await sqlDb().prepare('SELECT provider_id p FROM models').get()).p;
    const r = await admin.post(`/api/admin/providers/${pid}/models`).send({ modelId: 'fake-model', inputPrice: 1.5, outputPrice: 7 });
    expect(r.body.models[0]).toMatchObject({ inputPrice: 1.5, outputPrice: 7 });
    await admin.post(`/api/admin/providers/${pid}/models`).send({ modelId: 'fake-model', maxTokens: 999 }); // an unrelated edit leaves prices alone
    expect((await sqlDb().prepare('SELECT input_price i, output_price o FROM models').get())).toEqual({ i: 1.5, o: 7 });
    expect((await sqlDb().prepare("SELECT builtin FROM roles WHERE name='reporter'").get())).toEqual({ builtin: 1 });
  });
});
