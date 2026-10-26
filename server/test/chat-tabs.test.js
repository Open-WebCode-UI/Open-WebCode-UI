import { sqlDb } from './db-sql.js';
import { describe, it, expect } from 'vitest';
import { freshDb, createApp, login, makeRole, addProvider, fakeAdapterFactory } from './helpers.js';

import { DEFAULT_CHAT_PROMPT, DEFAULT_GENERAL_PROMPT } from '../src/agent/prompts.js';

let modelId;
const setup = async (seen = []) => { await freshDb(); modelId = await addProvider(); return createApp({ deps: { adapterFactory: fakeAdapterFactory([[{ type: 'text', text: 'ok' }], [{ type: 'text', text: 'ok' }], [{ type: 'text', text: 'ok' }]], seen) } }); };
const chat = (u, body) => u.post('/api/chat/turn').send({ modelId, ...body }).buffer(true).parse(async (r, cb) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => cb(null, d)); });
const convId = (res) => JSON.parse(res.body.split('\n\n').find((l) => l.startsWith('data: ')).slice(6)).conversationId;

describe('chat tabs', async () => {
  it('General and Coding use their own system prompts and keep separate chat lists', async () => {
    const seen = [], app = await setup(seen), u = await login(app, { username: 'tabber' });
    const g = await chat(u, { chatType: 'general', message: 'plan my week' });
    expect(seen.at(-1).system).toContain(DEFAULT_GENERAL_PROMPT); expect(seen.at(-1).system).not.toContain('coding assistant');
    const c = await chat(u, { chatType: 'coding', message: 'explain closures' });
    expect(seen.at(-1).system).toContain(DEFAULT_CHAT_PROMPT);
    await chat(u, { message: 'no type means coding' }); expect(seen.at(-1).system).toContain(DEFAULT_CHAT_PROMPT);
    expect((await u.get('/api/conversations?kind=chat&chatType=general')).body.map((x) => x.id)).toEqual([convId(g)]);
    expect((await u.get('/api/conversations?kind=chat&chatType=coding')).body).toHaveLength(2);
    expect(convId(c)).not.toBe(convId(g));
  });

  it('a chat cannot be continued from the other tab', async () => {
    const app = await setup(), u = await login(app, { username: 'tabber2' });
    const id = convId(await chat(u, { chatType: 'general', message: 'hi' }));
    expect((await chat(u, { chatType: 'coding', message: 'again', conversationId: id })).status).toBe(404);
  });

  it('each tab needs its own permission', async () => {
    const app = await setup(), codingOnly = await makeRole('codingonly', ['chat.use', 'provider.use']), generalOnly = await makeRole('generalonly', ['chat.general.use', 'provider.use']);
    expect(codingOnly && generalOnly).toBeTruthy();
    const a = await login(app, { username: 'codingonly1', roles: ['codingonly'] }), b = await login(app, { username: 'generalonly1', roles: ['generalonly'] });
    expect((await chat(a, { chatType: 'general', message: 'x' })).status).toBe(403);
    expect((await chat(a, { chatType: 'coding', message: 'x' })).status).toBe(200);
    expect((await chat(b, { chatType: 'coding', message: 'x' })).status).toBe(403);
    expect((await chat(b, { chatType: 'general', message: 'x' })).status).toBe(200);
  });

  it('web search and memory are separate permissions per tab', async () => {
    const app = await setup();
    await makeRole('searchgeneral', ['chat.use', 'chat.general.use', 'provider.use', 'websearch.use', 'chat.general.websearch']);
    const u = await login(app, { username: 'searcher1', roles: ['searchgeneral'] });
    const notice = async (chatType) => { const res = await chat(u, { chatType, message: 'x', webSearch: true }); return res.body.includes('your role does not allow it'); };
    expect(await notice('coding')).toBe(true);   // no chat.coding.websearch
    expect(await notice('general')).toBe(false); // allowed here (any later notice is about the missing search service, not the role)
  });

  it('both tabs can save to and read from user memory, and only when it is switched on', async () => {
    await freshDb(); modelId = await addProvider();
    const seen = [], script = [];
    const app = createApp({ deps: { adapterFactory: fakeAdapterFactory(script, seen) } }), u = await login(app, { username: 'memtab' });
    await chat(u, { chatType: 'general', message: 'hi' });
    expect(seen.at(-1).tools).not.toContain('save_memory');
    await u.put('/api/memory/settings').send({ scope: 'user', enabled: true });
    for (const chatType of ['general', 'coding']) {
      script.push([{ type: 'tool_call', id: `s-${chatType}`, name: 'save_memory', args: { scope: 'user', text: `Likes ${chatType}` } }], [{ type: 'tool_call', id: `r-${chatType}`, name: 'read_memory', args: {} }], [{ type: 'text', text: 'ok' }]);
      const res = await chat(u, { chatType, message: 'remember' });
      expect(seen.at(-1).tools).toEqual(expect.arrayContaining(['save_memory', 'read_memory']));
      expect(res.body).toContain('memory_saved');
      expect(res.body).toContain(`Likes ${chatType}`);
    }
    await chat(u, { chatType: 'general', message: 'again' });
    expect(seen.at(-1).system).toContain('- Likes general');
  });

  it('the General prompt can be overridden in the profile', async () => {
    const seen = [], app = await setup(seen), u = await login(app, { username: 'prompter2' });
    expect((await u.get('/api/profile/prompts')).body.defaults.general).toBe(DEFAULT_GENERAL_PROMPT);
    await u.put('/api/profile/prompts').send({ general: 'Be a pirate.' });
    await chat(u, { chatType: 'general', message: 'hi' });
    expect(seen.at(-1).system).toBe('Be a pirate.');
    await chat(u, { chatType: 'coding', message: 'hi' }); expect(seen.at(-1).system).toBe(DEFAULT_CHAT_PROMPT);
  });
});

describe('managing chats', async () => {
  it('renames a chat, and only your own', async () => {
    const app = await setup(), u = await login(app, { username: 'renamer1' }), o = await login(app, { username: 'other1' });
    const id = convId(await chat(u, { chatType: 'general', message: 'hi' }));
    expect((await u.put(`/api/conversations/${id}`).send({ title: '  Trip plan ' })).body.title).toBe('Trip plan');
    expect((await u.get('/api/conversations?kind=chat&chatType=general')).body[0].title).toBe('Trip plan');
    expect((await u.put(`/api/conversations/${id}`).send({ title: '' })).status).toBe(400);
    expect((await o.put(`/api/conversations/${id}`).send({ title: 'mine now' })).status).toBe(404);
  });

  it('bulk delete removes the selected chats, or every chat of that tab, and nothing else', async () => {
    const app = await setup([]), u = await login(app, { username: 'deleter1' }), o = await login(app, { username: 'deleter2' });
    const g = [convId(await chat(u, { chatType: 'general', message: 'a' })), convId(await chat(u, { chatType: 'general', message: 'b' })), convId(await chat(u, { chatType: 'general', message: 'c' }))];
    const code = convId(await chat(u, { chatType: 'coding', message: 'd' })), theirs = convId(await chat(o, { chatType: 'general', message: 'e' }));
    expect((await u.post('/api/conversations/bulk-delete').send({ chatType: 'general', ids: [] })).status).toBe(400);
    const some = await u.post('/api/conversations/bulk-delete').send({ chatType: 'general', ids: [g[0], code, theirs] });
    expect(some.body).toMatchObject({ deleted: 1, deletedIds: [g[0]] }); // the Coding chat and another user's chat are not touched
    expect((await u.post('/api/conversations/bulk-delete').send({ chatType: 'general', all: true })).body.deleted).toBe(2);
    expect((await u.get('/api/conversations?kind=chat&chatType=general')).body).toEqual([]);
    expect((await u.get('/api/conversations?kind=chat&chatType=coding')).body).toHaveLength(1);
    expect((await o.get('/api/conversations?kind=chat&chatType=general')).body).toHaveLength(1);
    expect((await sqlDb().prepare('SELECT COUNT(*) n FROM messages WHERE conversation_id=?').get(g[1])).n).toBe(0);
  });

  it('existing chats without a type are Coding chats', async () => {
    const app = await setup(), u = await login(app, { username: 'legacy1' });
    (await sqlDb().prepare("INSERT INTO conversations (user_id, kind, title) VALUES (?, 'chat', 'old chat')").run(u.id));
    expect((await u.get('/api/conversations?kind=chat&chatType=coding')).body.map((c) => c.title)).toEqual(['old chat']);
    expect((await u.get('/api/conversations?kind=chat&chatType=general')).body).toEqual([]);
  });
});

describe('bulk-deleting agent sessions', async () => {
  it('deletes the selected or all of a project\'s sessions and reports the rest', async () => {
    const app = await setup(), u = await login(app, { username: 'sessdel1' });
    const project = (await u.post('/api/projects').send({ name: 'p1' })).body;
    const mk = async (title) => Number((await sqlDb().prepare("INSERT INTO conversations (user_id, project_id, kind, title) VALUES (?,?, 'agent', ?)").run(u.id, project.id, title)).lastInsertRowid);
    const [a, b, c] = [await mk('a'), await mk('b'), await mk('c')];
    expect((await u.post('/api/sessions/bulk-delete').send({ projectId: project.id })).status).toBe(400);
    expect((await u.post('/api/sessions/bulk-delete').send({ projectId: project.id, ids: [a] })).body).toMatchObject({ deleted: 1, deletedIds: [a], skipped: 0 });
    expect((await u.get(`/api/sessions?projectId=${project.id}`)).body.map((s) => s.id).sort()).toEqual([b, c].sort());
    expect((await u.post('/api/sessions/bulk-delete').send({ projectId: project.id, all: true })).body.deleted).toBe(2);
    expect((await u.get(`/api/sessions?projectId=${project.id}`)).body).toEqual([]);
  });
  it("never touches another user's sessions", async () => {
    const app = await setup(), u = await login(app, { username: 'sessdel2' }), o = await login(app, { username: 'sessdel3' });
    const project = (await u.post('/api/projects').send({ name: 'p2' })).body;
    const id = Number((await sqlDb().prepare("INSERT INTO conversations (user_id, project_id, kind, title) VALUES (?,?, 'agent', 'x')").run(u.id, project.id)).lastInsertRowid);
    expect((await o.post('/api/sessions/bulk-delete').send({ projectId: project.id, all: true })).status).toBe(404);
    expect((await sqlDb().prepare('SELECT 1 FROM conversations WHERE id=?').get(id))).toBeTruthy();
  });
});
