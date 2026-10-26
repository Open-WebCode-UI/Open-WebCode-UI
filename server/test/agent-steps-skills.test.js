import Database from 'better-sqlite3';
import { legacySchema } from '../src/db/legacy-migrate.js';
import { sqlDb } from './db-sql.js';
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getToolsFor, executeTool, TERMINAL_TOOLS } from '../src/agent/tools.js';
import { runAgentTurn } from '../src/agent/loop.js';
import { createCheckpoint } from '../src/workspace/checkpoints.js';
import { systemPromptFor, DEFAULT_PLAN_PROMPT, DEFAULT_ACT_PROMPT } from '../src/agent/prompts.js';
import { BUILTIN_SKILLS, expandSkillInvocation, listSkills } from '../src/skills.js';
import { freshDb, createApp, login, makeRole, addProvider, fakeAdapterFactory, tmpDir } from './helpers.js';
import { openDb } from '../src/db/index.js';

const skillsFixture = [{ name: 'code-review', description: 'review', instructions: 'Check the code.' }];
let root, data;
const ctx = (o = {}) => ({ root, projectId: 1, execMode: 'files_only', agentMode: 'act', permissions: new Set(['agent.act']), secretGlobs: [], dataDir: data, skills: skillsFixture, ...o });
const names = (c) => getToolsFor(c).map((t) => t.name);
beforeEach(() => { root = tmpDir('steps-'); data = tmpDir('steps-d-'); fs.writeFileSync(path.join(root, 'a.txt'), 'one\n'); });

describe('conclude / switch_mode / use_skill / list_changes tool registry', () => {
  it('conclude is offered in both modes and ends the turn', () => {
    expect(names(ctx({ agentMode: 'plan' }))).toContain('conclude'); expect(names(ctx())).toContain('conclude');
    expect([...TERMINAL_TOOLS].sort()).toEqual(['conclude', 'propose_plan', 'switch_mode']);
  });
  it('switch_mode: Plan offers it only if the user could act; Act can revert; chat has no tools', () => {
    expect(names(ctx({ agentMode: 'plan' }))).toContain('switch_mode');
    expect(names(ctx({ agentMode: 'plan', permissions: new Set(['agent.plan']) }))).not.toContain('switch_mode');
    expect(names(ctx())).toContain('switch_mode');
    expect(getToolsFor(ctx({ agentMode: 'chat' }))).toEqual([]);
  });
  it('use_skill appears only when the user has enabled skills', () => {
    expect(names(ctx())).toContain('use_skill'); expect(names(ctx({ skills: [] }))).not.toContain('use_skill');
  });
  it('new tools are read-only, so they exist in Plan mode without weakening it', () => {
    const plan = names(ctx({ agentMode: 'plan', execMode: 'workspace_shell', permissions: new Set(['agent.act', 'agent.shell.run']) }));
    for (const m of ['write_file', 'edit_file', 'delete_file', 'create_checkpoint', 'run_command']) expect(plan).not.toContain(m);
  });
});

describe('executing the new tools', () => {
  it('conclude normalizes its payload and reports it to the caller', async () => {
    let got; await executeTool('conclude', { summary: 'Done', status: 'weird', changes: ['a.txt', 3], next_steps: 'nope' }, ctx({ onConclude: (c) => { got = c; } }));
    expect(got).toEqual({ summary: 'Done', status: 'complete', changes: ['a.txt', '3'], verification: '', next_steps: [], needs: '' });
  });
  it('switch_mode: Plan->act asks for confirmation (changes nothing); Act->plan reverts; wrong direction is rejected', async () => {
    const calls = [];
    const h = { onModeRequest: (m) => calls.push(['request', m]), onModeChange: (m) => calls.push(['change', m]) };
    expect(await executeTool('switch_mode', { mode: 'act', reason: 'ready' }, ctx({ agentMode: 'plan', ...h }))).toMatch(/confirm/);
    expect(await executeTool('switch_mode', { mode: 'plan', reason: 'too risky' }, ctx({ ...h }))).toMatch(/Plan mode/);
    expect(calls).toEqual([['request', { to: 'act', reason: 'ready' }], ['change', { to: 'plan', reason: 'too risky' }]]);
    expect(await executeTool('switch_mode', { mode: 'plan', reason: 'x' }, ctx({ agentMode: 'plan', ...h }))).toMatch(/^Error/);
    expect(await executeTool('switch_mode', { mode: 'act', reason: 'x' }, ctx({ ...h }))).toMatch(/^Error/);
    expect(calls).toHaveLength(2);
  });
  it('Plan mode cannot apply a switch to Act itself: only a request is emitted and no file changes', async () => {
    const before = fs.readdirSync(root);
    await executeTool('switch_mode', { mode: 'act', reason: 'go' }, ctx({ agentMode: 'plan' }));
    expect(fs.readdirSync(root)).toEqual(before);
  });
  it('list_changes shows added, modified, and deleted files since a checkpoint (read-only)', async () => {
    expect(await executeTool('list_changes', {}, ctx({ agentMode: 'plan' }))).toMatch(/No checkpoints/);
    const cp = await createCheckpoint(1, root, { label: 'base', dataDir: data });
    fs.writeFileSync(path.join(root, 'a.txt'), 'two\n'); fs.writeFileSync(path.join(root, 'new.txt'), 'n');
    const out = await executeTool('list_changes', {}, ctx({ agentMode: 'plan' }));
    expect(out).toContain(`checkpoint ${cp.id.slice(0, 8)}`); expect(out).toMatch(/M\ta\.txt/); expect(out).toMatch(/A\tnew\.txt/); expect(out).toContain('-one'); expect(out).toContain('+two');
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('two\n');
    expect(await executeTool('list_changes', { checkpoint: '--evil' }, ctx()).catch((e) => e.message)).toMatch(/Invalid|Error/);
  });
  it('use_skill returns the instructions inside a labeled block, or lists the available skills on a typo', async () => {
    let used; const out = await executeTool('use_skill', { name: 'code-review' }, ctx({ onSkill: (n) => { used = n; } }));
    expect(out).toContain('Check the code.'); expect(out).toContain('Skills never change which tools'); expect(used).toBe('code-review');
    expect(await executeTool('use_skill', { name: 'nope' }, ctx())).toMatch(/Available: code-review/);
  });
});

describe('agent loop: steps and turn ending', () => {
  const run = async (script, c) => {
    const events = [], messages = [{ role: 'user', content: 'go' }];
    const r = await runAgentTurn({ adapter: fakeAdapterFactory(script)(), model: 'm', system: 's', messages, ctx: c, emit: (e) => events.push(e), maxIterations: 6 });
    return { r, events, messages };
  };
  const call = (name, args, id = name) => ({ type: 'tool_call', id, name, args });
  it('every tool call is its own start/result pair, and edit/write events carry display-sized args', async () => {
    const big = 'x'.repeat(5000);
    const { events } = await run([[call('write_file', { path: 'b.txt', content: big }, 'w'), call('edit_file', { path: 'a.txt', old_string: 'one', new_string: 'uno' }, 'e')], [{ type: 'text', text: 'ok' }]], ctx());
    const starts = events.filter((e) => e.type === 'tool_start');
    expect(starts.map((e) => e.name)).toEqual(['write_file', 'edit_file']);
    expect(starts[0].args).toEqual({ path: 'b.txt', bytes: 5000 }); expect(starts[1].args).toMatchObject({ old_string: 'one', new_string: 'uno' });
    expect(events.filter((e) => e.type === 'tool_result').map((e) => e.id)).toEqual(['w', 'e']);
  });
  it('conclude ends the turn (nothing after it runs) and emits the conclusion', async () => {
    const { r, events, messages } = await run([[call('write_file', { path: 'z.txt', content: 'z' }), call('conclude', { summary: 'All good', status: 'complete', changes: ['z.txt'] })], [call('write_file', { path: 'never.txt', content: 'x' })]],
      ctx({ onConclude: (c) => events2.push({ type: 'conclusion', ...c }) }));
    expect(r.stopped).toBe('handed_back'); expect(events.at(-1).type).toBe('done');
    expect(fs.existsSync(path.join(root, 'never.txt'))).toBe(false); expect(messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });
  it('switch_mode ends the turn too; a rejected switch does not', async () => {
    const ok = await run([[call('switch_mode', { mode: 'act', reason: 'go' })]], ctx({ agentMode: 'plan' }));
    expect(ok.r.stopped).toBe('handed_back');
    const bad = await run([[call('switch_mode', { mode: 'plan', reason: 'x' })], [{ type: 'text', text: 'retry' }]], ctx({ agentMode: 'plan' }));
    expect(bad.r.stopped).toBe('complete'); // error result fed back, model continued
  });
});
const events2 = [];

describe('endpoint events', () => {
  const parse = (text) => text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  const turn = (u, body) => u.post('/api/agent/turn').send(body).buffer(true).parse((res, cb) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => cb(null, d)); });
  const setup = async (script) => { await freshDb(); const modelId = await addProvider(); const app = createApp({ deps: { adapterFactory: fakeAdapterFactory(script, setup.seen = []) } }); return { app, modelId }; };

  it('streams a conclusion event (distinct from text) at the end of an Act turn', async () => {
    const { app, modelId } = await setup([[{ type: 'tool_call', id: 'w', name: 'write_file', args: { path: 'a.txt', content: 'x' } }], [{ type: 'tool_call', id: 'c', name: 'conclude', args: { summary: 'Created a.txt', status: 'complete', changes: ['a.txt'], verification: 'read it back', next_steps: ['commit'] } }]]);
    const u = await login(app, { username: 'concluder' }); const p = (await u.post('/api/projects').send({ name: 'cp1' })).body;
    const ev = parse((await turn(u, { projectId: p.id, message: 'go', mode: 'act', modelId })).body);
    expect(ev.map((e) => e.type)).toEqual(expect.arrayContaining(['tool_start', 'tool_result', 'conclusion', 'done']));
    expect(ev.find((e) => e.type === 'conclusion')).toMatchObject({ summary: 'Created a.txt', status: 'complete', changes: ['a.txt'], next_steps: ['commit'] });
    expect(ev.at(-1).type).toBe('done');
  });
  it('Plan mode: switch_mode emits mode_request and the turn ends; no files change', async () => {
    const { app, modelId } = await setup([[{ type: 'tool_call', id: 's', name: 'switch_mode', args: { mode: 'act', reason: 'small fix' } }]]);
    const u = await login(app, { username: 'switcher1' }); const p = (await u.post('/api/projects').send({ name: 'cp2' })).body;
    const ev = parse((await turn(u, { projectId: p.id, message: 'fix typo', mode: 'plan', modelId })).body);
    expect(ev.find((e) => e.type === 'mode_request')).toEqual({ type: 'mode_request', to: 'act', reason: 'small fix' });
    expect((await u.get(`/api/projects/${p.id}/tree`)).body).toEqual([]);
  });
  it('Act mode: switch_mode reverts to plan, is audited, and ends the turn', async () => {
    const { app, modelId } = await setup([[{ type: 'tool_call', id: 's', name: 'switch_mode', args: { mode: 'plan', reason: 'this deletes data' } }]]);
    const u = await login(app, { username: 'reverter1' }); const p = (await u.post('/api/projects').send({ name: 'cp3' })).body;
    const ev = parse((await turn(u, { projectId: p.id, message: 'go', mode: 'act', modelId })).body);
    expect(ev.find((e) => e.type === 'mode_changed')).toEqual({ type: 'mode_changed', to: 'plan', reason: 'this deletes data' });
    expect((await sqlDb().prepare("SELECT COUNT(*) c FROM audit WHERE action='agent.mode_reverted'").get()).c).toBe(1);
  });
  it('a user without agent.act is never offered switch_mode in Plan mode', async () => {
    const { app, modelId } = await setup([[{ type: 'text', text: 'hi' }]]);
    await makeRole('planonly', ['project.read', 'project.write', 'files.read', 'agent.plan', 'provider.use']);
    const u = await login(app, { username: 'planonly2', roles: ['planonly'] }); const p = (await u.post('/api/projects').send({ name: 'cp4' })).body;
    await turn(u, { projectId: p.id, message: 'x', mode: 'plan', modelId });
    expect(setup.seen[0].tools).not.toContain('switch_mode');
  });
  it('system prompts teach the agent how to use conclude, switch_mode, skills, and list_changes', () => {
    for (const t of ['conclude', 'switch_mode', 'use_skill', 'list_changes', 'propose_plan']) expect(DEFAULT_PLAN_PROMPT).toContain(t);
    for (const t of ['conclude', 'switch_mode', 'use_skill', 'list_changes']) expect(DEFAULT_ACT_PROMPT).toContain(t);
    expect(DEFAULT_ACT_PROMPT).toMatch(/LAST action/); expect(DEFAULT_PLAN_PROMPT).toMatch(/last action/);
    const sp = systemPromptFor('act', null, { skills: [{ name: 'code-review', description: 'Review code' }] });
    expect(sp).toContain('# Skills'); expect(sp).toContain('- code-review: Review code');
    expect(systemPromptFor('plan', null, { skills: [] })).not.toContain('# Skills');
  });
});

describe('skills', () => {
  let app, u;
  beforeEach(async () => { await freshDb(); app = createApp(); u = await login(app, { username: 'skiller1' }); });

  it('ships useful pre-written skills, enabled by default', async () => {
    const list = (await u.get('/api/skills')).body;
    for (const n of ['code-review', 'security-review', 'write-tests', 'debug', 'refactor', 'explain-code', 'document']) {
      const s = list.find((x) => x.name === n); expect(s, n).toBeTruthy(); expect(s).toMatchObject({ builtin: true, enabled: true, modified: false });
      expect(s.instructions.length).toBeGreaterThan(400); expect(s.description.length).toBeGreaterThan(20);
    }
    expect(BUILTIN_SKILLS.find((b) => b.key === 'security-review').instructions).toMatch(/OWASP|injection/i);
  });
  it('built-ins can be modified (per user), toggled, and reset to the default', async () => {
    const r = await u.put('/api/skills/builtin/code-review').send({ instructions: 'My custom review rules' });
    expect(r.status).toBe(200);
    let s = (await u.get('/api/skills')).body.find((x) => x.name === 'code-review');
    expect(s).toMatchObject({ instructions: 'My custom review rules', modified: true }); expect(s.defaults.instructions).toMatch(/^# Code review/);
    await u.put('/api/skills/builtin/code-review').send({ enabled: false });
    s = (await u.get('/api/skills')).body.find((x) => x.name === 'code-review');
    expect(s).toMatchObject({ enabled: false, instructions: 'My custom review rules' }); // earlier edit kept
    const other = await login(app, { username: 'skiller2' });
    expect((await other.get('/api/skills')).body.find((x) => x.name === 'code-review')).toMatchObject({ modified: false, enabled: true }); // not shared
    await u.del('/api/skills/builtin/code-review');
    expect((await u.get('/api/skills')).body.find((x) => x.name === 'code-review')).toMatchObject({ modified: false, enabled: true, instructions: BUILTIN_SKILLS.find((b) => b.key === 'code-review').instructions });
    expect((await u.put('/api/skills/builtin/nonexistent').send({ enabled: false })).status).toBe(404);
  });
  it('custom skills: create, edit, disable, delete; names validated and unique', async () => {
    const c = await u.post('/api/skills').send({ name: 'api-review', description: 'Review our REST conventions', instructions: 'Check route naming.' });
    expect(c.status).toBe(201);
    expect((await u.get('/api/skills')).body.find((x) => x.name === 'api-review')).toMatchObject({ builtin: false, enabled: true });
    expect((await u.put(`/api/skills/custom/${c.body.id}`).send({ name: 'api-review', description: 'd', instructions: 'v2', enabled: false })).status).toBe(200);
    expect((await u.get('/api/skills')).body.find((x) => x.name === 'api-review')).toMatchObject({ instructions: 'v2', enabled: false });
    for (const bad of ['Bad Name', 'a', '-x', 'UPPER', 'x'.repeat(50)]) expect((await u.post('/api/skills').send({ name: bad, instructions: 'x' })).status, bad).toBe(400);
    expect((await u.post('/api/skills').send({ name: 'api-review', instructions: 'x' })).status).toBe(409);
    expect((await u.post('/api/skills').send({ name: 'debug', instructions: 'x' })).status).toBe(409); // reserved by a built-in
    expect((await u.post('/api/skills').send({ name: 'empty-one', instructions: '' })).status).toBe(400);
    expect((await u.del(`/api/skills/custom/${c.body.id}`)).status).toBe(200);
    expect((await u.del(`/api/skills/custom/${c.body.id}`)).status).toBe(404);
  });
  it('users cannot read or change each other\'s skills', async () => {
    const c = await u.post('/api/skills').send({ name: 'mine-only', instructions: 'secret rules' });
    const other = await login(app, { username: 'skiller3' });
    expect((await other.get('/api/skills')).body.some((s) => s.name === 'mine-only')).toBe(false);
    expect((await other.put(`/api/skills/custom/${c.body.id}`).send({ name: 'mine-only', instructions: 'hijack' })).status).toBe(404);
    expect((await other.del(`/api/skills/custom/${c.body.id}`)).status).toBe(404);
    expect((await sqlDb().prepare('SELECT instructions FROM skills WHERE id=?').get(c.body.id)).instructions).toBe('secret rules');
  });
  it('editing requires profile.skills.edit (listing does not)', async () => {
    await makeRole('viewer', ['chat.use']); const v = await login(app, { username: 'skillview', roles: ['viewer'] });
    expect((await v.get('/api/skills?scope=chat')).status).toBe(200);
    expect((await v.get('/api/skills')).status).toBe(403); // agent skills need agent access
    expect((await v.post('/api/skills?scope=chat').send({ name: 'nope', instructions: 'x' })).status).toBe(403);
    expect((await v.put('/api/skills/builtin/debug?scope=chat').send({ enabled: false })).status).toBe(403);
    expect((await u.post('/api/skills').send({ name: 'okay-one', instructions: 'x' })).status).toBe(201); // developer role has it
  });
  it('the developer role gets the new permission on databases created before skills existed', async () => {
    const dir = tmpDir('skills-migr-'); const file = `${dir}/old.db`;
    // The legacy schema with a developer role that lacks the skills permission and no one-time grant recorded.
    const old = new Database(file);
    old.exec(legacySchema);
    old.exec("INSERT INTO roles (name, description, builtin) VALUES ('developer','d',1); INSERT INTO role_permissions VALUES (1, 'chat.use');");
    old.close();
    const db = await openDb(file);
    expect(await db('role_permissions').where({ role_id: 1, permission: 'profile.skills.edit' }).first()).toBeTruthy();
    await db.destroy();
  });
  it('/skill-name expands server-side for the model; the user\'s own text is what history shows', async () => {
    const id = (await login(app, { username: 'slash1' })).id;
    const inv = await expandSkillInvocation(id, '/code-review src/app.js please');
    expect(inv.skill.name).toBe('code-review'); expect(inv.display).toBe('/code-review src/app.js please');
    expect(inv.content).toContain('<skill-instructions>'); expect(inv.content).toContain('User request: src/app.js please');
    expect((await expandSkillInvocation(id, '/code-review')).content).toContain('Apply this skill to the current project.');
    expect(await expandSkillInvocation(id, '/unknown-skill hi')).toBeNull(); expect(await expandSkillInvocation(id, 'not a /code-review')).toBeNull();
    (await sqlDb().prepare("INSERT INTO skills (user_id, builtin_key, name, description, instructions, enabled) VALUES (?,?,?,?,?,0)").run(id, 'debug', 'debug', 'd', 'x'));
    expect(await expandSkillInvocation(id, '/debug now')).toBeNull(); // disabled skills are not invocable
  });
  it('invoking a skill in chat and agent turns sends the instructions to the model and saves the original text', async () => {
    const modelId = await addProvider(); const seen = [];
    const app2 = createApp({ deps: { adapterFactory: fakeAdapterFactory([[{ type: 'text', text: 'reviewed' }], [{ type: 'text', text: 'again' }]], seen) } });
    const w = await login(app2, { username: 'slash2' });
    const res = await w.post('/api/chat/turn').send({ message: '/code-review the login flow', modelId }).buffer(true).parse((r, cb) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => cb(null, d)); });
    const ev = res.body.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.slice(6)));
    const sent = seen[0].messages[0].content;
    expect(sent).toContain('Review the code the user pasted'); expect(sent).toContain('User request: the login flow'); // the chat version of the skill, not the agent's
    const conv = ev[0].conversationId;
    expect((await w.get(`/api/conversations/${conv}/messages`)).body[0]).toMatchObject({ role: 'user', content: '/code-review the login flow' });
    const p = (await w.post('/api/projects').send({ name: 'sk1' })).body;
    const t = await w.post('/api/agent/turn').send({ projectId: p.id, message: '/code-review', mode: 'plan', modelId }).buffer(true).parse((r, cb) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => cb(null, d)); });
    expect(t.body).toContain('"type":"skill"'); expect(seen[1].system).toContain('# Skills'); expect(seen[1].system).toContain('- code-review:');
  });
  it('listSkills only includes the caller\'s data', async () => { expect((await listSkills((await login(app, { username: 'lister1' })).id)).length).toBe(BUILTIN_SKILLS.length); });
});
