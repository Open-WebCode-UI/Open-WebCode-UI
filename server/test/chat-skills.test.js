import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { freshDb, createApp, login, addProvider, fakeAdapterFactory, tmpDir } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { openDb, setDb } from '../src/db/index.js';
import { BUILTIN_SKILLS, CHAT_BUILTIN_SKILLS, expandSkillInvocation, listSkills } from '../src/skills.js';

const names = (r) => r.body.map((s) => s.name);

describe('chat skills are separate from agent skills', () => {
  it('each scope lists only its own built-in skills (agent is the default)', async () => {
    freshDb(); const u = login(createApp(), { username: 'scoper1' });
    expect(names(await u.get('/api/skills'))).toEqual(BUILTIN_SKILLS.map((s) => s.name));
    expect(names(await u.get('/api/skills?scope=agent'))).toContain('compact');
    const chat = await u.get('/api/skills?scope=chat');
    expect(names(chat)).toEqual(CHAT_BUILTIN_SKILLS.map((s) => s.name));
    expect(names(chat)).not.toContain('compact'); expect(names(chat)).not.toContain('security-review');
    expect(chat.body.every((s) => s.scope === 'chat' && !s.action)).toBe(true);
    // chat skills never tell the model to use tools it does not have
    for (const s of CHAT_BUILTIN_SKILLS) expect(s.instructions, s.name).not.toMatch(/list_changes|read_file|\bcheckpoint\b|use_skill/);
    expect((await u.get('/api/skills?scope=nonsense')).status).toBe(400);
  });

  it('editing, disabling, resetting and creating in one scope leaves the other alone', async () => {
    freshDb(); const u = login(createApp(), { username: 'scoper2' });
    await u.put('/api/skills/builtin/code-review?scope=chat').send({ instructions: 'Chat-only rules.' });
    await u.put('/api/skills/builtin/debug').send({ enabled: false }); // agent
    const get = async (scope, n) => (await u.get(`/api/skills?scope=${scope}`)).body.find((s) => s.name === n);
    expect(await get('chat', 'code-review')).toMatchObject({ instructions: 'Chat-only rules.', modified: true });
    expect(await get('agent', 'code-review')).toMatchObject({ modified: false, instructions: BUILTIN_SKILLS.find((b) => b.key === 'code-review').instructions });
    expect(await get('agent', 'debug')).toMatchObject({ enabled: false }); expect(await get('chat', 'debug')).toMatchObject({ enabled: true });
    const c = await u.post('/api/skills?scope=chat').send({ name: 'tone-check', description: 'd', instructions: 'Check tone.' });
    expect(c.status).toBe(201);
    expect(await get('chat', 'tone-check')).toMatchObject({ builtin: false, scope: 'chat' }); expect(await get('agent', 'tone-check')).toBeUndefined();
    // the same custom name can exist in both scopes, and one scope's skill cannot be edited through the other
    expect((await u.post('/api/skills').send({ name: 'tone-check', instructions: 'agent version' })).status).toBe(201);
    expect((await u.put(`/api/skills/custom/${c.body.id}`).send({ name: 'other-name', instructions: 'hijack' })).status).toBe(404); // default scope is agent
    expect((await u.put(`/api/skills/custom/${c.body.id}?scope=chat`).send({ name: 'tone-check', instructions: 'v2' })).status).toBe(200);
    expect((await u.del(`/api/skills/builtin/code-review?scope=chat`)).status).toBe(200);
    expect(await get('chat', 'code-review')).toMatchObject({ modified: false });
    expect((await u.put('/api/skills/builtin/summarize').send({ enabled: false })).status).toBe(404); // a chat built-in is not an agent built-in
    expect((await u.post('/api/skills?scope=chat').send({ name: 'summarize', instructions: 'x' })).status).toBe(409);
    expect((await u.post('/api/skills?scope=chat').send({ name: 'compact', instructions: 'x' })).status).toBe(201); // /compact is an agent command only
  });

  it('a slash skill in chat uses the chat scope; agent-only skills are not invocable there', async () => {
    freshDb(); const app0 = createApp(); const u = login(app0, { username: 'scoper3' });
    expect((await expandSkillInvocation(u.id, '/summarize this', 'chat'))?.content).toContain('Summarize the text the user pasted');
    expect(await expandSkillInvocation(u.id, '/summarize this')).toBeNull();
    expect(await expandSkillInvocation(u.id, '/security-review x', 'chat')).toBeNull();
    expect(await expandSkillInvocation(u.id, '/security-review x')).not.toBeNull();
    getDb().prepare("INSERT INTO skills (user_id, scope, builtin_key, name, description, instructions, enabled) VALUES (?, 'chat', 'summarize', 'summarize', 'd', 'x', 0)").run(u.id);
    expect(await expandSkillInvocation(u.id, '/summarize', 'chat')).toBeNull();
    expect((await listSkills(u.id, 'chat')).length).toBe(CHAT_BUILTIN_SKILLS.length);
  });

  it('the agent only offers its own skills to the model', async () => {
    freshDb(); const modelId = addProvider(), seen = [];
    const app = createApp({ deps: { adapterFactory: fakeAdapterFactory([[{ type: 'text', text: 'ok' }]], seen) } }); const u = login(app, { username: 'scoper4' });
    await u.post('/api/skills?scope=chat').send({ name: 'chat-only-thing', description: 'for chat', instructions: 'x' });
    const p = (await u.post('/api/projects').send({ name: 'sc' })).body;
    await u.post('/api/agent/turn').send({ projectId: p.id, message: 'hi', mode: 'plan', modelId }).buffer(true).parse((r, cb) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => cb(null, d)); });
    expect(seen[0].system).toContain('- code-review:'); expect(seen[0].system).not.toContain('chat-only-thing'); expect(seen[0].system).not.toContain('- summarize:');
  });
});

describe('skills table migration', () => {
  it('moves existing skills into the agent scope and lets both scopes reuse a name', async () => {
    const file = path.join(tmpDir(), 'old.db');
    const first = openDb(file);
    first.exec('DROP TABLE skills'); // the shape before scopes existed
    first.exec("CREATE TABLE skills (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, builtin_key TEXT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), UNIQUE (user_id, name))");
    const uid = Number(first.prepare("INSERT INTO users (username, source, display_name) VALUES ('old','local','Old')").run().lastInsertRowid);
    first.prepare("INSERT INTO skills (user_id, builtin_key, name, description, instructions, enabled) VALUES (?, 'debug','debug','d','custom debug',0)").run(uid);
    first.prepare("INSERT INTO skills (user_id, name, description, instructions) VALUES (?, 'mine','d','mine')").run(uid);
    first.close();
    const db = openDb(file); setDb(db);
    expect(db.prepare('SELECT name, scope, enabled FROM skills ORDER BY name').all()).toEqual([{ name: 'debug', scope: 'agent', enabled: 0 }, { name: 'mine', scope: 'agent', enabled: 1 }]);
    expect((await listSkills(uid, 'agent')).find((s) => s.name === 'debug')).toMatchObject({ enabled: false, instructions: 'custom debug' });
    expect((await listSkills(uid, 'chat')).find((s) => s.name === 'debug')).toMatchObject({ enabled: true });
    db.prepare("INSERT INTO skills (user_id, scope, name, instructions) VALUES (?, 'chat', 'mine', 'chat mine')").run(uid); // same name, other scope
    expect(openDb(file).prepare('SELECT COUNT(*) n FROM skills').get().n).toBe(3); // reopening is a no-op
  });
});
