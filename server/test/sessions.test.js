import { loadSettings } from '../src/settings.js';
import { sqlDb } from './db-sql.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTimeline, estimateTokens, contextInfo, renderTranscript, COMMAND_RE, DEFAULT_CONTEXT_WINDOW } from '../src/sessions.js';
import { freshDb, createApp, login, makeRole, addProvider, fakeAdapterFactory } from './helpers.js';


const row = (m, extra = {}) => ({ role: m.role, content: JSON.stringify(m), archived: 0, kind: null, ...extra });
const call = (name, args, id) => ({ id: id || `${name}1`, name, args });
const parse = (text) => text.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));

describe('buildTimeline (rebuilding what the UI shows)', () => {
  it('turns stored messages into user / reply / tool-step / conclusion items, in order', () => {
    const t = buildTimeline([
      row({ role: 'user', content: '/code-review src/a.js', display: '/code-review src/a.js' }),
      row({ role: 'assistant', content: 'Reading it.', thinking: 'hmm', toolCalls: [call('read_file', { path: 'src/a.js' }, 'r1'), call('write_file', { path: 'b.txt', content: 'x'.repeat(4000) }, 'w1')] }),
      row({ role: 'tool', toolCallId: 'r1', name: 'read_file', content: '1\tcode' }), row({ role: 'tool', toolCallId: 'w1', name: 'write_file', content: 'Wrote b.txt' }),
      row({ role: 'assistant', content: '', toolCalls: [call('conclude', { summary: 'Done', status: 'weird', changes: ['b.txt', 5] }, 'c1')] }), row({ role: 'tool', toolCallId: 'c1', name: 'conclude', content: 'Turn concluded.' }),
    ]);
    expect(t.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'conclusion']);
    expect(t[0].text).toBe('/code-review src/a.js'); expect(t[1]).toMatchObject({ text: 'Reading it.', thinking: 'hmm' });
    expect(t[2]).toMatchObject({ name: 'read_file', result: '1\tcode', args: { path: 'src/a.js' } }); expect(t[3].args).toEqual({ path: 'b.txt', bytes: 4000 }); // file bodies are not sent back to the browser
    expect(t[4].c).toEqual({ summary: 'Done', status: 'complete', changes: ['b.txt', '5'], verification: '', next_steps: [], needs: '' });
  });
  it('shows what the user typed rather than the expanded skill text', () => { expect(buildTimeline([row({ role: 'user', content: '<skill-instructions>…', display: '/debug boom' })])[0].text).toBe('/debug boom'); });
  it('a plan is pending only while the session says so; mode requests and reverts come back as cards', () => {
    const rows = [row({ role: 'assistant', content: '', toolCalls: [call('propose_plan', { plan: '1. Do it' }, 'p1')] }), row({ role: 'tool', toolCallId: 'p1', content: 'ok' }),
      row({ role: 'assistant', content: '', toolCalls: [call('switch_mode', { mode: 'act', reason: 'small' }, 's1')] }), row({ role: 'assistant', content: '', toolCalls: [call('switch_mode', { mode: 'plan', reason: 'risky' }, 's2')] })];
    expect(buildTimeline(rows).find((i) => i.kind === 'plan').state).toBe('approved'); expect(buildTimeline(rows, { pendingPlan: '1. Do it' }).find((i) => i.kind === 'plan').state).toBe('pending');
    expect(buildTimeline(rows, { pendingPlan: 'something else' }).find((i) => i.kind === 'plan').state).toBe('approved');
    expect(buildTimeline(rows).filter((i) => ['mode_request', 'mode_changed'].includes(i.kind)).map((i) => [i.kind, i.reason])).toEqual([['mode_request', 'small'], ['mode_changed', 'risky']]);
  });
  it('subagents come back with their mode, status, and report', () => {
    const t = buildTimeline([row({ role: 'assistant', content: '', toolCalls: [call('spawn_agent', { task: 'Count files', name: 'counter', mode: 'act' }, 'S1')] }),
      row({ role: 'tool', toolCallId: 'S1', content: 'Subagent "counter" (act mode) finished: partial.\n\nFound 3 files.' })]);
    expect(t[0]).toMatchObject({ kind: 'subagent', name: 'counter', mode: 'act', status: 'partial', summary: 'Found 3 files.', task: 'Count files' });
  });
  it('archived messages stay in the timeline; a compaction summary marks where the agent context restarts', () => {
    const t = buildTimeline([row({ role: 'user', content: 'old 1' }, { archived: 1 }), row({ role: 'assistant', content: 'old 2' }, { archived: 1 }),
      row({ role: 'user', content: '[Summary of the earlier conversation, which was compacted to save context]\n\n## Goal\nBuild x' }, { kind: 'summary' }), row({ role: 'assistant', content: 'Understood.' }, { kind: 'summary_ack' }), row({ role: 'user', content: 'next' })]);
    expect(t.map((i) => i.kind)).toEqual(['user', 'assistant', 'compacted', 'user']); expect(t[2]).toMatchObject({ archived: 2, summary: '## Goal\nBuild x' });
    expect(buildTimeline([row({ role: 'user', content: 'x' }, { archived: 1 }), row({ role: 'user', content: 'cleared' }, { kind: 'cleared' })])[1]).toEqual({ kind: 'cleared', archived: 1 });
  });
});

describe('context size', () => {
  it('estimates roughly four characters per token, counting tool calls, and classifies the level', () => {
    expect(estimateTokens([{ role: 'user', content: 'a'.repeat(400) }, { role: 'assistant', content: '', toolCalls: [{ name: 'read_file', args: { path: 'x' } }] }])).toBeGreaterThanOrEqual(100);
    expect(estimateTokens([], 4000)).toBe(1000);
    expect(contextInfo(30_000, 100_000)).toMatchObject({ level: 'ok', pct: 30 }); expect(contextInfo(60_000, 100_000).level).toBe('warn'); expect(contextInfo(85_000, 100_000).level).toBe('high'); expect(contextInfo(5).limit).toBe(DEFAULT_CONTEXT_WINDOW);
  });
  it('the transcript given to the summarizer shrinks long tool output and stays under its cap', () => {
    const msgs = [{ role: 'user', content: 'go' }, ...Array.from({ length: 200 }, (_, i) => ({ role: 'tool', name: 'read_file', content: 'z'.repeat(5000) + i }))];
    expect(renderTranscript(msgs, 300_000).length).toBeLessThanOrEqual(300_000); expect(renderTranscript(msgs, 50_000).length).toBeLessThanOrEqual(50_100); expect(renderTranscript([{ role: 'user', content: 'hi' }])).toBe('User: hi');
  });
  it('recognizes /compact and /clear (with an optional focus) and nothing else', () => {
    expect(COMMAND_RE.exec('/compact keep the db decisions')[2]).toBe('keep the db decisions'); expect(COMMAND_RE.exec('/CLEAR')[1]).toBe('CLEAR'); expect(COMMAND_RE.exec('/compactor')).toBeNull(); expect(COMMAND_RE.exec('please /compact')).toBeNull();
  });
});

describe('sessions API', () => {
  let app, u, project, modelId, seen;
  const turn = (who, body) => who.post('/api/agent/turn').send({ message: 'hi', mode: 'plan', modelId, ...body }).buffer(true).parse((r, cb) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => cb(null, d)); });
  const events = async (who, body) => parse((await turn(who, body)).body);
  const setup = async (script, user = 'sessuser1') => { await freshDb(); modelId = await addProvider(); seen = []; app = createApp({ deps: { adapterFactory: fakeAdapterFactory(script, seen) } }); u = await login(app, { username: user }); return u.post('/api/projects').send({ name: 'sp' }).then((r) => { project = r.body; }); };
  const text = (t) => [{ type: 'text', text: t }];

  it('lists sessions per project, newest first, with mode, size, and message count; other users and projects are separate', async () => {
    await setup([text('one'), text('two'), text('three')]);
    const a = (await events(u, { projectId: project.id, message: 'first topic' }))[0].conversationId; (await sqlDb().prepare('UPDATE conversations SET updated_at=updated_at-100 WHERE id=?').run(a));
    const b = (await events(u, { projectId: project.id, message: 'second topic', mode: 'act' }))[0].conversationId;
    const list = (await u.get(`/api/sessions?projectId=${project.id}`)).body;
    expect(list.map((s) => s.id)).toEqual([b, a]); expect(list[0]).toMatchObject({ title: 'second topic', mode: 'act', messages: 2, running: false }); expect(list[0].context).toMatchObject({ level: 'ok', limit: DEFAULT_CONTEXT_WINDOW });
    const p2 = (await u.post('/api/projects').send({ name: 'other' })).body; expect((await u.get(`/api/sessions?projectId=${p2.id}`)).body).toEqual([]);
    const other = await login(app, { username: 'sessuser2' }); expect((await other.get(`/api/sessions?projectId=${project.id}`)).status).toBe(404); // not their project
    expect((await (await login(app, { username: 'sessuser3' })).get(`/api/sessions/${a}`)).status).toBe(404);
  });
  it('opening a session returns its full timeline, mode, and context so the user can continue', async () => {
    await setup([[{ type: 'tool_call', id: 't1', name: 'list_dir', args: { path: '.' } }], text('Here is the project.')]);
    const id = (await events(u, { projectId: project.id, message: 'look around' }))[0].conversationId;
    const s = (await u.get(`/api/sessions/${id}`)).body;
    expect(s).toMatchObject({ id, title: 'look around', mode: 'plan', pendingPlan: null, running: false }); expect(s.items.map((i) => i.kind)).toEqual(['user', 'tool', 'assistant']);
    expect(s.items[1]).toMatchObject({ name: 'list_dir', result: '(empty)' }); expect(s.items[2].text).toBe('Here is the project.');
  });
  it('continuing a session sends the earlier messages to the model', async () => {
    await setup([text('I remember.'), text('Yes.')]);
    const id = (await events(u, { projectId: project.id, message: 'my name is Zed' }))[0].conversationId;
    await events(u, { projectId: project.id, conversationId: id, message: 'who am I?' });
    expect(seen[1].messages.map((m) => m.content)).toEqual(['my name is Zed', 'I remember.', 'who am I?']);
  });
  it('remembers the mode and a plan waiting for approval; an Act turn consumes the plan', async () => {
    await setup([[{ type: 'tool_call', id: 'p1', name: 'propose_plan', args: { plan: '1. Add route' } }], text('implemented')]);
    const id = (await events(u, { projectId: project.id, message: 'plan it' }))[0].conversationId;
    let s = (await u.get(`/api/sessions/${id}`)).body; expect(s.pendingPlan).toBe('1. Add route'); expect(s.items.find((i) => i.kind === 'plan').state).toBe('pending');
    await events(u, { projectId: project.id, conversationId: id, message: 'go', mode: 'act', approvedPlan: '1. Add route' });
    s = (await u.get(`/api/sessions/${id}`)).body; expect(s).toMatchObject({ mode: 'act', pendingPlan: null }); expect(s.items.find((i) => i.kind === 'plan').state).toBe('approved');
  });
  it('rename and delete (own sessions only); a running session cannot be deleted or run twice', async () => {
    await setup([text('ok')]); const id = (await events(u, { projectId: project.id, message: 'topic' }))[0].conversationId;
    expect((await u.put(`/api/sessions/${id}`).send({ title: '  Auth work  ' })).body.title).toBe('Auth work'); expect((await u.put(`/api/sessions/${id}`).send({ title: '' })).status).toBe(400);
    expect((await u.get(`/api/sessions?projectId=${project.id}`)).body[0].title).toBe('Auth work');
    expect((await (await login(app, { username: 'sessuser4' })).put(`/api/sessions/${id}`).send({ title: 'x' })).status).toBe(404);
    expect((await u.del(`/api/sessions/${id}`)).status).toBe(200); expect((await u.get(`/api/sessions/${id}`)).status).toBe(404); expect((await sqlDb().prepare('SELECT COUNT(*) c FROM messages WHERE conversation_id=?').get(id)).c).toBe(0);
  });
  it('rejects a second turn on a session that is still running, and shows it as running', async () => {
    await freshDb(); modelId = await addProvider(); let release; const gate = new Promise((r) => { release = r; });
    app = createApp({ deps: { adapterFactory: () => ({ async *stream() { await gate; yield { type: 'text', text: 'late' }; yield { type: 'done' }; } }) } }); u = await login(app, { username: 'sessuser5' });
    project = (await u.post('/api/projects').send({ name: 'busy' })).body;
    const first = turn(u, { projectId: project.id }).then((r) => r); await new Promise((r) => setTimeout(r, 300)); // (a superagent request only starts once it is awaited)
    const id = (await u.get(`/api/sessions?projectId=${project.id}`)).body[0]; expect(id.running).toBe(true);
    expect((await u.del(`/api/sessions/${id.id}`)).body.error).toBe('session_busy');
    const clash = await u.post('/api/agent/turn').send({ projectId: project.id, conversationId: id.id, message: 'again', mode: 'plan', modelId }); expect(clash.status).toBe(409);
    release(); await first; expect((await u.get(`/api/sessions?projectId=${project.id}`)).body[0].running).toBe(false);
  });
  it('needs agent.plan', async () => { await setup([]); await makeRole('chatonly', ['chat.use']); const c = await login(app, { username: 'chatonly1', roles: ['chatonly'] }); expect((await c.get(`/api/sessions?projectId=${project.id}`)).status).toBe(403); });
});

describe('context warnings and compaction', () => {
  let app, u, project, modelId, seen;
  const turn = (body) => u.post('/api/agent/turn').send({ mode: 'plan', modelId, projectId: project.id, ...body }).buffer(true).parse((r, cb) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => cb(null, d)); }).then((r) => parse(r.body));
  const setup = async (script, user = 'compactor1') => { await freshDb(); modelId = await addProvider(); seen = []; app = createApp({ deps: { adapterFactory: fakeAdapterFactory(script, seen) } }); u = await login(app, { username: user }); project = (await u.post('/api/projects').send({ name: 'cp' })).body; };
  const text = (t) => [{ type: 'text', text: t }];
  const summary = '## Goal\nBuild the thing\n## Next step\nWrite tests';

  it('reports the context size just before the turn ends, and escalates as it fills', async () => {
    await setup([text('ok'), text('ok'), text('ok'), text('ok')]);
    let ev = await turn({ message: 'hi' }); const base = ev.find((e) => e.type === 'context'); expect(ev.at(-1).type).toBe('done'); expect(ev.indexOf(base)).toBe(ev.length - 2); // right before done
    expect(base).toMatchObject({ level: 'ok', limit: DEFAULT_CONTEXT_WINDOW }); expect(base.tokens).toBeGreaterThan(500); // the fixed prompt counts too
    const limit = Math.round(base.tokens / 0.4); (await sqlDb().prepare('UPDATE models SET context_size=? WHERE id=?').run(limit, modelId)); await loadSettings(); (await sqlDb().prepare("INSERT INTO settings (key,value) VALUES ('general', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify({ defaultModels: { plan: modelId, act: modelId, chat: null } })));
    const id = ev[0].conversationId, chars = (frac) => 'x'.repeat(Math.round(limit * frac * 4));
    ev = await turn({ message: 'again', conversationId: id }); expect(ev.find((e) => e.type === 'context'), JSON.stringify(ev)).toMatchObject({ limit, level: 'ok' });
    ev = await turn({ message: chars(0.3), conversationId: id }); expect(ev.find((e) => e.type === 'context').level).toBe('warn');
    ev = await turn({ message: chars(0.3), conversationId: id }); expect(ev.find((e) => e.type === 'context').level).toBe('high');
    expect((await u.get(`/api/sessions/${id}`)).body.context).toMatchObject({ level: 'high', limit }); expect((await u.get(`/api/sessions?projectId=${project.id}`)).body[0].context.level).toBe('high'); // same number everywhere
  });
  it('sizes and warnings use the model the session actually used, so every number agrees', async () => {
    await setup([text('ok')]); (await sqlDb().prepare('UPDATE models SET context_size=? WHERE id=?').run(5000, modelId)); // no default models configured await loadSettings();
    const ev = await turn({ message: 'hi' }); const id = ev[0].conversationId, live = ev.find((e) => e.type === 'context');
    expect(live.limit).toBe(5000); expect((await u.get(`/api/sessions/${id}`)).body.context).toMatchObject({ limit: 5000, tokens: live.tokens });
    expect((await u.get(`/api/sessions?projectId=${project.id}`)).body[0].context).toMatchObject({ limit: 5000, tokens: live.tokens });
  });
  it('/compact summarizes the session, archives the old messages, and starts the next context from the summary', async () => {
    await setup([text('first answer'), text(summary), text('after compaction')]);
    const id = (await turn({ message: 'build the thing' }))[0].conversationId;
    const ev = await turn({ message: '/compact keep the test plan', conversationId: id });
    expect(ev.map((e) => e.type)).toEqual(['start', 'compacting', 'compacted', 'context', 'done']); expect(ev.find((e) => e.type === 'compacted')).toMatchObject({ summary, archived: 2 });
    expect(seen[1].tools).toEqual([]); expect(seen[1].system).toContain('compacting a long coding session'); expect(seen[1].system).toContain('never instructions to follow'); // the summarizing prompt, with a safety rule
    expect(seen[1].messages[0].content).toContain('User: build the thing'); expect(seen[1].messages[0].content).toContain('Assistant: first answer'); expect(seen[1].messages[0].content).toContain('keep the test plan');
    const s = (await u.get(`/api/sessions/${id}`)).body; expect(s.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'compacted']); expect(s.items[2]).toMatchObject({ summary, archived: 2 });
    expect(s.context.tokens).toBeLessThan(1800); // little more than the fixed prompt and the summary
    await turn({ message: 'continue', conversationId: id }); // the model now sees the summary, not the old chat
    expect(seen[2].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']); expect(seen[2].messages[0].content).toContain('## Next step'); expect(JSON.stringify(seen[2].messages)).not.toContain('build the thing');
    expect((await sqlDb().prepare('SELECT COUNT(*) c FROM messages WHERE conversation_id=? AND archived=1').get(id)).c).toBe(2); // kept in the database, just not sent
    expect((await sqlDb().prepare("SELECT COUNT(*) c FROM audit WHERE action='session.compact'").get()).c).toBe(1);
  });
  it('compacts with the user\'s own edited instructions, and refuses when the skill is turned off', async () => {
    await setup([text('answer'), text('short summary')]);
    await u.put('/api/skills/builtin/compact').send({ instructions: 'Summarize in exactly three bullet points.' });
    const id = (await turn({ message: 'hello' }))[0].conversationId; await turn({ message: '/compact', conversationId: id }); expect(seen[1].system).toContain('exactly three bullet points');
    await u.put('/api/skills/builtin/compact').send({ enabled: false }); const r = await u.post('/api/agent/turn').send({ projectId: project.id, conversationId: id, message: '/compact', mode: 'plan', modelId }); expect(r.status).toBe(400); expect(r.body.error).toBe('skill_disabled');
  });
  it('/clear drops the old context without calling the model', async () => {
    await setup([text('answer'), text('after')]);
    const id = (await turn({ message: 'secret plans' }))[0].conversationId; const calls = seen.length;
    const ev = await turn({ message: '/clear', conversationId: id }); expect(ev.map((e) => e.type)).toEqual(['start', 'cleared', 'context', 'done']); expect(seen.length).toBe(calls);
    expect((await u.get(`/api/sessions/${id}`)).body.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'cleared']);
    await turn({ message: 'fresh start', conversationId: id }); expect(JSON.stringify(seen.at(-1).messages)).not.toContain('secret plans');
  });
  it('nothing to compact in an empty session; commands never reach the model as chat', async () => {
    await setup([text('x')]); const ev = await turn({ message: '/compact' }); expect(ev.find((e) => e.type === 'notice').text).toMatch(/nothing to compact/i); expect(seen.length).toBe(0);
  });
  it('a failing summary leaves the session untouched', async () => {
    await freshDb(); modelId = await addProvider(); let n = 0;
    app = createApp({ deps: { adapterFactory: () => ({ async *stream() { n += 1; if (n === 2) throw new Error('model down'); yield { type: 'text', text: 'ok' }; yield { type: 'done' }; } }) } }); u = await login(app, { username: 'compactor2' }); project = (await u.post('/api/projects').send({ name: 'f' })).body;
    const id = (await turn({ message: 'hello' }))[0].conversationId; const ev = await turn({ message: '/compact', conversationId: id });
    expect(ev.find((e) => e.type === 'error').message).toMatch(/Could not compact/); expect((await u.get(`/api/sessions/${id}`)).body.items.map((i) => i.kind)).toEqual(['user', 'assistant']);
  });
  it('/compact is not an instruction the agent can load, and /clear cannot be shadowed by a custom skill', async () => {
    await setup([text('x')]); const names = (await u.get('/api/skills')).body; expect(names.find((s) => s.name === 'compact')).toMatchObject({ builtin: true, action: 'compact', enabled: true });
    expect((await u.post('/api/skills').send({ name: 'clear', instructions: 'x' })).status).toBe(409); expect((await u.post('/api/skills').send({ name: 'compact', instructions: 'x' })).status).toBe(409);
    await turn({ message: 'hi' }); expect(seen[0].system).not.toMatch(/- compact:/); expect(seen[0].system).toMatch(/- code-review:/);
  });
});
