import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { parse } from 'yaml';
import { freshDb, createApp, login, request, addProvider, fakeAdapterFactory } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { registry } from '../src/http.js';
import { SPEC_FILE } from '../src/routes/apidocs.js';
import { saveSettings, getSettings } from '../src/settings.js';
import { resetRateLimits } from '../src/ratelimit.js';
import { toNeutral } from '../src/routes/v1.js';

let app, script, admin, user, modelRow;
const enable = (over = {}) => saveSettings('api', { ...getSettings('api'), enabled: true, ...over });
const v1 = (key) => (method, url) => request(app)[method](url).set('Authorization', `Bearer ${key}`);
async function newKey(client, body = { name: 'ci' }) {
  const r = await client.post('/api/api-keys').send(body);
  expect(r.status).toBe(201);
  return r.body;
}
const chat = (key, body) => v1(key)('post', '/v1/chat/completions').send({ model: 'p/fake-model', messages: [{ role: 'user', content: 'hi' }], ...body });

beforeEach(() => {
  freshDb(); script = [];
  app = createApp({ deps: { adapterFactory: fakeAdapterFactory(script) } });
  admin = login(app, { username: 'rootadmin', roles: ['administrator'] });
  user = login(app, { username: 'apiuser', roles: ['api-user'] });
  modelRow = addProvider();
});

describe('API keys: who may do what', () => {
  it('needs api.use to list or create keys', async () => {
    const dev = login(app, { username: 'devperson' });
    expect((await dev.get('/api/api-keys')).status).toBe(403);
    expect((await dev.post('/api/api-keys').send({ name: 'x' })).status).toBe(403);
    expect((await user.get('/api/api-keys')).status).toBe(200);
  });
  it('creating a key needs a recent MFA check', async () => {
    const stale = login(app, { username: 'stale', roles: ['api-user'], stepup: false });
    const r = await stale.post('/api/api-keys').send({ name: 'x' });
    expect(r.status).toBe(403); expect(r.body.error).toBe('mfa_required');
  });
  it('shows the secret once and stores only a hash', async () => {
    const k = await newKey(user);
    expect(k.key).toMatch(/^owui_/);
    const row = getDb().prepare('SELECT * FROM api_keys WHERE id=?').get(k.id);
    expect(JSON.stringify(row)).not.toContain(k.key);
    const listed = (await user.get('/api/api-keys')).body.keys;
    expect(listed).toHaveLength(1); expect(listed[0].key).toBeUndefined(); expect(listed[0].prefix).toBe(k.key.slice(0, 9));
  });
  it('lets people see and change only their own keys', async () => {
    const mine = await newKey(user), other = login(app, { username: 'other', roles: ['api-user'] });
    expect((await other.get('/api/api-keys')).body.keys).toHaveLength(0);
    expect((await other.put(`/api/api-keys/${mine.id}`).send({ name: 'stolen' })).status).toBe(404);
    expect((await other.del(`/api/api-keys/${mine.id}`)).status).toBe(404);
    const renamed = await user.put(`/api/api-keys/${mine.id}`).send({ name: 'renamed' });
    expect(renamed.status).toBe(200); expect(renamed.body.name).toBe('renamed');
    expect((await user.del(`/api/api-keys/${mine.id}`)).status).toBe(200);
    expect((await user.get('/api/api-keys')).body.keys).toHaveLength(0);
  });
  it('enforces the key limit, the maximum lifetime, and model restrictions', async () => {
    saveSettings('api', { ...getSettings('api'), maxKeysPerUser: 1, maxKeyDays: 30 });
    expect((await user.post('/api/api-keys').send({ name: 'a' })).body.error).toBe('expiry_required');
    expect((await user.post('/api/api-keys').send({ name: 'a', expiresInDays: 31 })).status).toBe(400);
    expect((await user.post('/api/api-keys').send({ name: 'a', expiresInDays: 30, modelIds: [9999] })).body.error).toBe('model_unavailable');
    const ok = await user.post('/api/api-keys').send({ name: 'a', expiresInDays: 30, modelIds: [modelRow] });
    expect(ok.status).toBe(201); expect(ok.body.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect((await user.post('/api/api-keys').send({ name: 'b', expiresInDays: 1 })).status).toBe(409);
  });
  it('lets administrators list and revoke every key; others cannot', async () => {
    enable();
    const k = await newKey(user);
    expect((await user.get('/api/admin/api-keys')).status).toBe(403);
    const all = await admin.get('/api/admin/api-keys');
    expect(all.body[0]).toMatchObject({ id: k.id, owner: { name: 'apiuser' } });
    makeReader();
    expect((await login(app, { username: 'reader', roles: ['key-reader'] }).del(`/api/admin/api-keys/${k.id}`)).status).toBe(403);
    expect((await admin.del(`/api/admin/api-keys/${k.id}`)).status).toBe(200);
    expect((await v1(k.key)('get', '/v1/models')).status).toBe(401);
    expect(getDb().prepare("SELECT 1 FROM audit WHERE action='apikey.revoke'").get()).toBeTruthy();
  });
  it('API settings need settings.read / settings.write and are audited', async () => {
    expect((await user.get('/api/admin/api-settings')).status).toBe(403);
    expect((await admin.put('/api/admin/api-settings').send({ enabled: true, rateLimitPerMin: 5 })).body).toMatchObject({ enabled: true, rateLimitPerMin: 5, maxKeysPerUser: 10 });
    expect((await admin.put('/api/admin/api-settings').send({ rateLimitPerMin: 0 })).status).toBe(400);
    expect(getDb().prepare("SELECT 1 FROM audit WHERE action='settings.api'").get()).toBeTruthy();
  });
});
function makeReader() { const id = Number(getDb().prepare("INSERT INTO roles (name) VALUES ('key-reader')").run().lastInsertRowid); getDb().prepare("INSERT INTO role_permissions VALUES (?, 'api.keys.read')").run(id); }

describe('/v1 authentication', () => {
  it('is off until an administrator turns it on', async () => {
    const k = await newKey(user);
    const r = await v1(k.key)('get', '/v1/models');
    expect(r.status).toBe(503); expect(r.body.error.code).toBe('api_disabled');
  });
  it('rejects missing, malformed and unknown keys in the OpenAI error envelope', async () => {
    enable();
    for (const h of [undefined, 'Bearer', 'Bearer nope', 'Basic abc', 'Bearer owui_unknown']) {
      const r = await request(app).get('/v1/models').set(...(h ? ['Authorization', h] : ['X-Other', '1']));
      expect(r.status).toBe(401); expect(r.body.error).toMatchObject({ type: 'authentication_error', code: 'invalid_api_key' });
    }
  });
  it('does not accept a browser session in place of a key', async () => {
    enable();
    expect((await user.get('/v1/models')).status).toBe(401);
  });
  it('stops working when the owner loses api.use, is disabled, or the key expires', async () => {
    enable();
    const k = await newKey(user);
    expect((await v1(k.key)('get', '/v1/models')).status).toBe(200);
    getDb().prepare("DELETE FROM user_roles WHERE user_id=?").run(user.id);
    expect((await v1(k.key)('get', '/v1/models')).status).toBe(403);
    getDb().prepare("INSERT INTO user_roles (user_id, role_id) SELECT ?, id FROM roles WHERE name='api-user'").run(user.id);
    expect((await v1(k.key)('get', '/v1/models')).status).toBe(200);
    getDb().prepare('UPDATE api_keys SET expires_at=1 WHERE id=?').run(k.id);
    expect((await v1(k.key)('get', '/v1/models')).status).toBe(401);
    getDb().prepare('UPDATE api_keys SET expires_at=NULL WHERE id=?').run(k.id);
    getDb().prepare('UPDATE users SET disabled=1 WHERE id=?').run(user.id);
    expect((await v1(k.key)('get', '/v1/models')).status).toBe(401);
  });
  it('rate limits per key', async () => {
    enable({ rateLimitPerMin: 2 });
    const k = await newKey(user);
    for (let i = 0; i < 2; i++) expect((await v1(k.key)('get', '/v1/models')).status).toBe(200);
    const r = await v1(k.key)('get', '/v1/models');
    expect(r.status).toBe(429); expect(r.headers['retry-after']).toBe('60');
    resetRateLimits();
    expect((await v1(k.key)('get', '/v1/models')).status).toBe(200);
  });
  it('throttles repeated bad keys from one address', async () => {
    enable();
    let last;
    for (let i = 0; i < 22; i++) last = await request(app).get('/v1/models').set('Authorization', 'Bearer owui_wrong');
    expect(last.status).toBe(429);
  });
  it('answers unknown /v1 paths as JSON, not the web app', async () => {
    enable();
    const k = await newKey(user);
    const r = await v1(k.key)('get', '/v1/nothing');
    expect(r.status).toBe(404); expect(r.body.error.code).toBe('not_found');
  });
});

describe('/v1/models', () => {
  it('lists usable models as <connection>/<model>, honouring role allow-lists and key restrictions', async () => {
    enable();
    const db = getDb();
    const pid = Number(db.prepare("INSERT INTO providers (name,type,config,allowed_roles) VALUES ('private','openai','{}','[\"developer\"]')").run().lastInsertRowid);
    const second = Number(db.prepare("INSERT INTO models (provider_id, model_id) VALUES (?, 'hidden')").run(pid).lastInsertRowid);
    db.prepare("INSERT INTO models (provider_id, model_id, enabled) VALUES (1, 'off', 0)").run();
    const k = await newKey(user);
    const ids = (await v1(k.key)('get', '/v1/models')).body.data.map((m) => m.id);
    expect(ids).toEqual(['p/fake-model']);
    const dev = login(app, { username: 'dev2', roles: ['developer', 'api-user'] }), dk = await newKey(dev);
    expect((await v1(dk.key)('get', '/v1/models')).body.data.map((m) => m.id)).toEqual(['p/fake-model', 'private/hidden']);
    const only = await newKey(dev, { name: 'narrow', modelIds: [second] });
    expect((await v1(only.key)('get', '/v1/models')).body.data.map((m) => m.id)).toEqual(['private/hidden']);
  });
});

describe('/v1/chat/completions', () => {
  it('returns a completion, records usage for the key owner, and applies model limits', async () => {
    enable(); script.push([{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'there' }]);
    const k = await newKey(user);
    const r = await chat(k.key, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ object: 'chat.completion', model: 'p/fake-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hello there' } }] });
    expect(r.body.usage.total_tokens).toBeGreaterThan(0);
    expect(getDb().prepare("SELECT user_id, kind, estimated FROM usage WHERE kind='api'").get()).toEqual({ user_id: user.id, kind: 'api', estimated: 1 });
  });
  it('passes system text, history and tools through, and returns tool calls', async () => {
    enable(); const seen = [];
    app = createApp({ deps: { adapterFactory: fakeAdapterFactory(script, seen) } });
    script.push([{ type: 'tool_call', id: 'c1', name: 'get_weather', args: { city: 'Oslo' } }]);
    const dev = login(app, { username: 'caller', roles: ['api-user'] }), k = await newKey(dev);
    const r = await chat(k.key, {
      messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: [{ type: 'text', text: 'Weather?' }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'p1', type: 'function', function: { name: 'x', arguments: '{"a":1}' } }] },
        { role: 'tool', tool_call_id: 'p1', content: 'ok' }, { role: 'user', content: 'now Oslo' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'd', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    });
    expect(r.status).toBe(200);
    expect(seen[0].system).toBe('Be brief.'); expect(seen[0].tools).toEqual(['get_weather']);
    expect(seen[0].messages[2]).toMatchObject({ role: 'tool', toolCallId: 'p1', name: 'x', content: 'ok' });
    expect(r.body.choices[0]).toMatchObject({ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] } });
  });
  it('streams server-sent events ending in [DONE], with usage on request', async () => {
    enable(); script.push([{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }, { type: 'usage', inputTokens: 5, outputTokens: 2 }]);
    const k = await newKey(user);
    const r = await chat(k.key, { stream: true, stream_options: { include_usage: true } }).buffer(true).parse((res, cb) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => cb(null, d)); });
    expect(r.status).toBe(200); expect(r.headers['content-type']).toMatch(/text\/event-stream/);
    const events = r.body.split('\n\n').filter(Boolean).map((e) => e.replace(/^data: /, ''));
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e));
    expect(chunks.map((c) => c.choices[0]?.delta?.content).filter(Boolean).join('')).toBe('Hello');
    expect(chunks.find((c) => c.choices[0]?.finish_reason)).toBeTruthy();
    expect(chunks.at(-1).usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    expect(getDb().prepare("SELECT input_tokens i, output_tokens o, estimated e FROM usage WHERE kind='api'").get()).toEqual({ i: 5, o: 2, e: 0 });
  });
  it('refuses unknown models, models outside the key, and unsupported input', async () => {
    enable();
    const k = await newKey(user);
    expect((await chat(k.key, { model: 'p/nope' })).status).toBe(404);
    const narrow = await newKey(user, { name: 'n', modelIds: [modelRow] });
    getDb().prepare("INSERT INTO models (provider_id, model_id) VALUES (1, 'second')").run();
    expect((await chat(narrow.key, { model: 'p/second' })).status).toBe(404);
    const img = await chat(k.key, { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:,' } }] }] });
    expect(img.status).toBe(400); expect(img.body.error.code).toBe('unsupported_content');
    expect((await chat(k.key, { n: 2 })).status).toBe(400);
    expect((await chat(k.key, { messages: [] })).body.error.code).toBe('validation_error');
    expect((await chat(k.key, { messages: [{ role: 'system', content: 'only system' }] })).body.error.code).toBe('no_messages');
    const bad = await v1(k.key)('post', '/v1/chat/completions').set('Content-Type', 'application/json').send('{oops');
    expect(bad.status).toBe(400); expect(bad.body.error.code).toBe('invalid_json');
  });
  it('hides upstream failures from the caller', async () => {
    enable();
    app = createApp({ deps: { adapterFactory: () => ({ async *stream() { throw new Error('secret upstream detail sk-123'); } }) } });
    const u = login(app, { username: 'failer', roles: ['api-user'] }), k = await newKey(u);
    const r = await chat(k.key, {});
    expect(r.status).toBe(502); expect(JSON.stringify(r.body)).not.toContain('sk-123');
  });
  it('maps messages to the neutral format', () => {
    expect(toNeutral([{ role: 'developer', content: 'a' }, { role: 'system', content: 'b' }, { role: 'user', content: 'hi' }])).toEqual({ system: 'a\n\nb', messages: [{ role: 'user', content: 'hi' }] });
  });
});

describe('documentation', () => {
  it('is visible only with api.docs.read', async () => {
    const dev = login(app, { username: 'devperson' });
    for (const p of ['/api/docs', '/api/docs/openapi.yaml', '/api/docs/redoc.js']) {
      expect((await dev.get(p)).status).toBe(403);
      expect((await request(app).get(p)).status).toBe(401);
    }
    expect((await user.get('/api/docs/openapi.yaml')).status).toBe(200);
    const page = await user.get('/api/docs');
    if (fs.existsSync(new URL('../openapi/dist/index.html', import.meta.url))) {
      expect(page.status).toBe(200);
      expect(page.headers['content-security-policy']).toMatch(/script-src 'self' 'sha256-/);
      expect(page.text).not.toMatch(/cdn\.redocly\.com|fonts\.googleapis\.com/);
    } else expect(page.status).toBe(503); // run "npm run docs:build"
  });
  it('documents exactly the routes the server has', () => {
    const spec = parse(fs.readFileSync(SPEC_FILE, 'utf8'));
    const documented = new Set(Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).filter((m) => ['get', 'post', 'put', 'delete'].includes(m)).map((m) => `${m.toUpperCase()} ${p}`)));
    const served = new Set(registry.filter((r) => /^\/v1\/|^\/api\/(api-keys|admin\/api-keys|admin\/api-settings|docs)/.test(r.path) && r.path !== '/api/docs/redoc.js')
      .map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, '{$1}')}`));
    expect([...documented].sort()).toEqual([...served].sort());
  });
});
