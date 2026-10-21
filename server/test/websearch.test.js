import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, login, addProvider, fakeAdapterFactory } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { resetRateLimits } from '../src/ratelimit.js';

const BACKEND = { provider: 'brave', apiKey: 'k-test' };
const braveJson = (results) => JSON.stringify({ web: { results } });

// A fake search service behind an injected fetch.
function fakeSearch(body = braveJson([{ title: 'Node.js 24', url: 'https://nodejs.org/en/blog', description: 'Release notes' }]), status = 200) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => { calls.push({ url: String(url), headers: init.headers }); return new Response(body, { status }); } };
}

async function turn(app, u, body) {
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const res = await fetch(`http://localhost:${server.address().port}${body.__url}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: u.cookie, 'x-csrf-token': u.csrf }, body: JSON.stringify({ ...body, __url: undefined }) });
  const events = []; let buf = '';
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString(); let i;
    while ((i = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); }
  }
  server.close();
  return events;
}

let app, dev, admin, modelId, seen, script, search;
async function setup(opts = {}) {
  const backend = 'backend' in opts ? opts.backend : BACKEND, s = opts.search ?? fakeSearch();
  freshDb(); resetRateLimits(); modelId = addProvider(); seen = []; script = []; search = s;
  app = createApp({ deps: { adapterFactory: fakeAdapterFactory(script, seen), webSearch: { backend, fetchImpl: search.fetchImpl } } });
  dev = login(app, { username: 'devone' });
  admin = login(app, { username: 'adminone', roles: ['administrator'] });
}
const allow = (on = true) => admin.put('/api/admin/general').send({ webSearchAllowed: on });
const chat = (extra = {}) => turn(app, dev, { __url: '/api/chat/turn', message: 'what is new in node?', modelId, ...extra });

describe('web search switches', () => {
  beforeEach(() => setup());

  it('is off for the tenant by default; only an administrator can change it', async () => {
    expect((await dev.get('/api/web-search')).body).toEqual({ allowed: false, configured: true, enabled: true });
    expect((await dev.put('/api/admin/general').send({ webSearchAllowed: true })).status).toBe(403);
    expect((await allow()).body.webSearchAllowed).toBe(true);
    expect((await dev.get('/api/web-search')).body.allowed).toBe(true);
  });

  it('lets the user switch it off and on for their profile, and audits the change', async () => {
    expect((await dev.put('/api/web-search/settings').send({ enabled: false })).body.enabled).toBe(false);
    expect((await dev.get('/api/web-search')).body.enabled).toBe(false);
    expect((await dev.put('/api/web-search/settings').send({ enabled: 'yes' })).status).toBe(400);
    expect(getDb().prepare("SELECT 1 FROM audit WHERE action='websearch.toggle'").get()).toBeTruthy();
  });

  it('offers no tool unless tenant, profile, and the chat itself are all on', async () => {
    await chat({ webSearch: true }); // tenant off
    expect(seen.at(-1).tools).toEqual([]);
    await allow();
    await chat(); // chat toggle not sent
    expect(seen.at(-1).tools).toEqual([]);
    await dev.put('/api/web-search/settings').send({ enabled: false });
    const ev = await chat({ webSearch: true }); // profile off
    expect(seen.at(-1).tools).toEqual([]);
    expect(ev.find((e) => e.type === 'notice').text).toMatch(/switched off in your profile/);
    await dev.put('/api/web-search/settings').send({ enabled: true });
    await chat({ webSearch: true });
    expect(seen.at(-1).tools).toEqual(['web_search']);
    expect(seen.at(-1).system).toMatch(/untrusted third-party content/);
  });

  it('is unavailable without the permission', async () => {
    await allow();
    getDb().prepare("DELETE FROM role_permissions WHERE permission='websearch.use'").run();
    const ev = await chat({ webSearch: true });
    expect(seen.at(-1).tools).toEqual([]);
    expect(ev.find((e) => e.type === 'notice').text).toMatch(/role does not allow/);
    expect((await dev.get('/api/web-search')).status).toBe(403);
  });

  it('remembers the toggle per chat and keeps one chat from affecting another', async () => {
    await allow();
    const id = (await chat({ webSearch: true })).find((e) => e.type === 'start').conversationId;
    const other = (await chat({ webSearch: false })).find((e) => e.type === 'start').conversationId;
    const list = (await dev.get('/api/conversations?kind=chat')).body;
    expect(list.find((c) => c.id === id).webSearch).toBe(1);
    expect(list.find((c) => c.id === other).webSearch).toBe(0);
    await chat({ conversationId: id }); // toggle omitted: the chat's saved choice applies
    expect(seen.at(-1).tools).toEqual(['web_search']);
    await chat({ conversationId: id, webSearch: false });
    expect(seen.at(-1).tools).toEqual([]);
  });
});

describe('web search tool', () => {
  beforeEach(async () => { await setup(); await allow(); });

  it('runs the search, returns labeled results to the model, then answers', async () => {
    script.push([{ type: 'tool_call', id: 's1', name: 'web_search', args: { query: 'node release' } }], [{ type: 'text', text: 'Node 24 is out.' }]);
    const ev = await chat({ webSearch: true });
    expect(search.calls[0].url).toContain('q=node+release');
    expect(search.calls[0].headers['x-subscription-token']).toBe('k-test');
    const toolMsg = seen.at(-1).messages.find((m) => m.role === 'tool');
    expect(toolMsg.content).toMatch(/untrusted/);
    expect(toolMsg.content).toContain('https://nodejs.org/en/blog');
    expect(ev.filter((e) => e.type === 'text').map((e) => e.text).join('')).toBe('Node 24 is out.');
    const audited = getDb().prepare("SELECT detail FROM audit WHERE action='websearch.query'").get();
    expect(JSON.stringify(audited)).not.toContain('node release'); // queries are not logged, only their size
  });

  it('refuses a call when search is off, even if the model asks anyway', async () => {
    script.push([{ type: 'tool_call', id: 's1', name: 'web_search', args: { query: 'x' } }], [{ type: 'text', text: 'ok' }]);
    await chat(); // toggle off: chat runs a single step, the tool is never executed
    expect(search.calls).toHaveLength(0);
  });

  it('is available to the Plan-mode agent and reports backend failures as tool errors', async () => {
    await setup({ search: fakeSearch('oops', 500) }); await allow();
    const proj = (await dev.post('/api/projects').send({ name: 'p1' })).body;
    script.push([{ type: 'tool_call', id: 's1', name: 'web_search', args: { query: 'x' } }], [{ type: 'text', text: 'ok' }]);
    await turn(app, dev, { __url: '/api/agent/turn', projectId: proj.id, message: 'look it up', mode: 'plan', modelId, webSearch: true });
    expect(seen[0].tools).toContain('web_search');
    expect(seen[1].messages.find((m) => m.role === 'tool').content).toMatch(/^Error: web search failed/);
  });

  it('is not offered when no search backend is configured', async () => {
    await setup({ backend: null }); await allow();
    const ev = await chat({ webSearch: true });
    expect(seen.at(-1).tools).toEqual([]);
    expect(ev.find((e) => e.type === 'notice').text).toMatch(/no search service/);
  });
});

describe('web search service settings (admin page)', () => {
  beforeEach(() => setup({ backend: undefined }));
  const brave = { provider: 'brave', apiKey: 'sk-secret-brave-key' };

  it('needs settings permissions and a recent step-up to save; the API key is stored encrypted and never returned', async () => {
    expect((await dev.get('/api/admin/web-search')).status).toBe(403);
    expect((await dev.put('/api/admin/web-search').send(brave)).status).toBe(403);
    const r = await admin.put('/api/admin/web-search').send(brave);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ provider: 'brave', url: '', allowPrivate: false, apiKeySet: true });
    expect(JSON.stringify((await admin.get('/api/admin/web-search')).body)).not.toContain('sk-secret');
    expect(getDb().prepare("SELECT value FROM settings WHERE key='webSearch'").get().value).not.toContain('sk-secret');
    expect(JSON.stringify(getDb().prepare("SELECT detail FROM audit WHERE action='settings.web_search.update'").all())).not.toContain('sk-secret');
  });

  it('keeps the stored key when none is sent, replaces it, and removes it on provider change', async () => {
    await admin.put('/api/admin/web-search').send(brave);
    expect((await admin.put('/api/admin/web-search').send({ provider: 'brave' })).body.apiKeySet).toBe(true);
    expect((await admin.put('/api/admin/web-search').send({ provider: 'brave', apiKey: '' })).body.apiKeySet).toBe(false);
    await admin.put('/api/admin/web-search').send(brave);
    expect((await admin.put('/api/admin/web-search').send({ provider: '' })).body).toEqual({ provider: '', url: '', allowPrivate: false, apiKeySet: false });
    expect((await dev.get('/api/web-search')).body.configured).toBe(false);
  });

  it('validates a SearXNG address (https, no private hosts unless allowed)', async () => {
    expect((await admin.put('/api/admin/web-search').send({ provider: 'searxng', url: '' })).status).toBe(400);
    expect((await admin.put('/api/admin/web-search').send({ provider: 'searxng', url: 'http://searx.example.com' })).status).toBe(400);
    expect((await admin.put('/api/admin/web-search').send({ provider: 'searxng', url: 'http://127.0.0.1:8080' })).status).toBe(400);
    expect((await admin.put('/api/admin/web-search').send({ provider: 'searxng', url: 'http://127.0.0.1:8080', allowPrivate: true })).body).toMatchObject({ provider: 'searxng', allowPrivate: true });
    expect((await dev.get('/api/web-search')).body.configured).toBe(true);
  });

  it('uses the saved service for real searches, and the test button reports the outcome', async () => {
    await allow();
    expect((await admin.post('/api/admin/web-search/test')).status).toBe(400); // nothing saved yet
    await admin.put('/api/admin/web-search').send(brave);
    script.push([{ type: 'tool_call', id: 's1', name: 'web_search', args: { query: 'node' } }], [{ type: 'text', text: 'ok' }]);
    await chat({ webSearch: true });
    expect(seen.at(-1).tools).toEqual(['web_search']);
    expect(search.calls[0].headers['x-subscription-token']).toBe('sk-secret-brave-key'); // decrypted from the saved setting
    expect((await admin.post('/api/admin/web-search/test')).body).toEqual({ ok: true, message: 'The service answered with results.' });
  });
});
