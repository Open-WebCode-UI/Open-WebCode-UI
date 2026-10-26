import Database from 'better-sqlite3';
import { legacySchema } from '../src/db/legacy-migrate.js';
import { sqlDb } from './db-sql.js';
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { freshDb, createApp, login, addProvider, fakeAdapterFactory, tmpDir } from './helpers.js';

import { openDb, setDb } from '../src/db/index.js';
import { BUILTIN_SKILLS, CHAT_BUILTIN_SKILLS, expandSkillInvocation, listSkills } from '../src/skills.js';

const names = (r) => r.body.map((s) => s.name);

describe('chat skills are separate from agent skills', () => {
  it('each scope lists only its own built-in skills (agent is the default)', async () => {
    await freshDb(); const u = await login(createApp(), { username: 'scoper1' });
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
    await freshDb(); const u = await login(createApp(), { username: 'scoper2' });
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
    await freshDb(); const app0 = createApp(); const u = await login(app0, { username: 'scoper3' });
    expect((await expandSkillInvocation(u.id, '/summarize this', 'chat'))?.content).toContain('Summarize the text the user pasted');
    expect(await expandSkillInvocation(u.id, '/summarize this')).toBeNull();
    expect(await expandSkillInvocation(u.id, '/security-review x', 'chat')).toBeNull();
    expect(await expandSkillInvocation(u.id, '/security-review x')).not.toBeNull();
    (await sqlDb().prepare("INSERT INTO skills (user_id, scope, builtin_key, name, description, instructions, enabled) VALUES (?, 'chat', 'summarize', 'summarize', 'd', 'x', 0)").run(u.id));
    expect(await expandSkillInvocation(u.id, '/summarize', 'chat')).toBeNull();
    expect((await listSkills(u.id, 'chat')).length).toBe(CHAT_BUILTIN_SKILLS.length);
  });

  it('the agent only offers its own skills to the model', async () => {
    await freshDb(); const modelId = await addProvider(), seen = [];
    const app = createApp({ deps: { adapterFactory: fakeAdapterFactory([[{ type: 'text', text: 'ok' }]], seen) } }); const u = await login(app, { username: 'scoper4' });
    await u.post('/api/skills?scope=chat').send({ name: 'chat-only-thing', description: 'for chat', instructions: 'x' });
    const p = (await u.post('/api/projects').send({ name: 'sc' })).body;
    await u.post('/api/agent/turn').send({ projectId: p.id, message: 'hi', mode: 'plan', modelId }).buffer(true).parse((r, cb) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => cb(null, d)); });
    expect(seen[0].system).toContain('- code-review:'); expect(seen[0].system).not.toContain('chat-only-thing'); expect(seen[0].system).not.toContain('- summarize:');
  });
});

describe('skills table migration', () => {
  it('moves existing skills into the agent scope and lets both scopes reuse a name', async () => {
    const file = path.join(tmpDir(), 'old.db');
    // A database from before skills had scopes: the legacy schema, with the skills table in its old shape and two rows.
    const old = new Database(file);
    old.exec(legacySchema);
    old.exec("DROP TABLE skills; CREATE TABLE skills (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, builtin_key TEXT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 0, UNIQUE (user_id, name));");
    old.prepare("INSERT INTO users (username, source, display_name) VALUES ('old','local','Old')").run();
    old.prepare("INSERT INTO skills (user_id, builtin_key, name, description, instructions, enabled) VALUES (1, 'debug','debug','d','custom debug',0)").run();
    old.prepare("INSERT INTO skills (user_id, name, description, instructions) VALUES (1, 'mine','d','mine')").run();
    old.close();
    const db = await openDb(file); await setDb(db);
    expect(await db.raw('SELECT name, scope, enabled FROM skills ORDER BY name')).toEqual([{ name: 'debug', scope: 'agent', enabled: 0 }, { name: 'mine', scope: 'agent', enabled: 1 }]);
    expect((await listSkills(1, 'agent')).find((s) => s.name === 'debug')).toMatchObject({ enabled: false, instructions: 'custom debug' });
    expect((await listSkills(1, 'chat')).find((s) => s.name === 'debug')).toMatchObject({ enabled: true });
    await db('skills').insert({ user_id: 1, scope: 'chat', name: 'mine', instructions: 'chat mine' }); // same name, other scope
    await db.destroy();
    const again = await openDb(file);
    expect(await again('skills').count({ n: '*' }).first().then((r) => r.n)).toBe(3); // reopening is a no-op
    await again.destroy();
  });
});
