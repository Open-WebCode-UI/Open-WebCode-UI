import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getToolsFor } from '../src/agent/tools.js';
import { runAgentTurn } from '../src/agent/loop.js';
import { createSubagentRuntime, MAX_SUBAGENTS_PER_TURN } from '../src/agent/subagent.js';
import { DEFAULT_PLAN_PROMPT, DEFAULT_ACT_PROMPT, DEFAULT_SUBAGENT_PROMPT } from '../src/agent/prompts.js';
import { listCheckpoints } from '../src/workspace/checkpoints.js';
import { freshDb, createApp, login, addProvider, makeRole, tmpDir } from './helpers.js';
import { getDb } from '../src/db/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (name, args, id) => ({ type: 'tool_call', id: id || `${name}-${Math.random().toString(36).slice(2, 7)}`, name, args });
const isChild = (a) => a.system.includes('You are a subagent');

// Adapter that answers differently for the parent and for children (children are told apart by their system prompt).
function brain({ parent, child, seen = [] }) {
  const parentSteps = [...parent];
  return {
    async *stream(args) {
      seen.push({ child: isChild(args), tools: args.tools.map((t) => t.name), system: args.system, first: args.messages[0]?.content });
      const steps = isChild(args) ? await child(args) : parentSteps.shift() || [{ type: 'text', text: 'done' }];
      for (const e of steps) yield e;
      yield { type: 'done' };
    },
  };
}
let root, data, events;
const perms = (...extra) => new Set(['agent.plan', 'agent.act', ...extra]);
function setup({ mode = 'act', permissions = perms(), parent, child, seen, approve, maxIterations = 6 }) {
  root = tmpDir('sub-'); data = tmpDir('sub-d-'); events = [];
  const ctx = { root, projectId: 1, execMode: 'files_only', agentMode: mode, permissions, secretGlobs: [], dataDir: data, subagents: true, skills: [], approve };
  const adapter = brain({ parent, child, seen });
  const opts = { adapter, model: 'm', system: 'parent', emit: (e) => events.push(e), maxIterations, maxTokens: 100, audit: (...a) => events.push({ type: '_audit', a }) };
  ctx.spawnSubagent = createSubagentRuntime({ ctx, permissions, ...opts });
  const messages = [{ role: 'user', content: 'go' }];
  return { messages, run: () => runAgentTurn({ ...opts, messages, ctx }), ctx };
}
const types = (t) => events.filter((e) => e.type === t);
const reportOf = (messages) => messages.filter((m) => m.role === 'tool').map((m) => m.content);

describe('spawn_agent availability', () => {
  const base = { execMode: 'files_only', permissions: perms() };
  it('is offered only when the model supports it, and never to subagents themselves', () => {
    for (const agentMode of ['plan', 'act']) {
      expect(getToolsFor({ ...base, agentMode, subagents: true }).map((t) => t.name)).toContain('spawn_agent');
      expect(getToolsFor({ ...base, agentMode, subagents: false }).map((t) => t.name)).not.toContain('spawn_agent');
      const child = getToolsFor({ ...base, agentMode, subagents: true, isSubagent: true, skills: [{ name: 'x' }] }).map((t) => t.name);
      for (const banned of ['spawn_agent', 'switch_mode', 'propose_plan', 'ask_user', 'use_skill']) expect(child).not.toContain(banned);
      expect(child).toContain('conclude'); expect(child).toContain('read_file');
    }
  });
  it('a plan-mode child has no mutating tools', () => {
    const t = getToolsFor({ ...base, agentMode: 'plan', subagents: true, isSubagent: true, permissions: perms('agent.shell.run') }).map((x) => x.name);
    for (const m of ['write_file', 'edit_file', 'delete_file', 'create_checkpoint', 'run_command']) expect(t).not.toContain(m);
  });
  it('prompts teach parents how to delegate and children how to report', () => {
    for (const p of [DEFAULT_PLAN_PROMPT, DEFAULT_ACT_PROMPT]) { expect(p).toContain('spawn_agent'); expect(p).toMatch(/parallel/); expect(p).toMatch(/stand alone/); }
    expect(DEFAULT_ACT_PROMPT).toMatch(/mode "act"/); expect(DEFAULT_SUBAGENT_PROMPT).toMatch(/conclude/); expect(DEFAULT_SUBAGENT_PROMPT).toMatch(/cannot see the parent/);
  });
});

describe('running subagents', () => {
  it('runs a child on a self-contained task and hands its report back to the parent', async () => {
    const seen = [];
    const t = setup({ seen, mode: 'plan',
      parent: [[call('spawn_agent', { task: 'Find the entry point and report its path.', name: 'find entry' }, 'S1')], [{ type: 'text', text: 'synthesized' }]],
      child: async () => [call('conclude', { summary: 'Entry point is src/index.js', status: 'complete', changes: [], verification: 'read it' })] });
    fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/index.js'), 'x');
    const r = await t.run();
    expect(r.stopped).toBe('complete');
    expect(seen.filter((s) => s.child)).toHaveLength(1); expect(seen.find((s) => s.child).first).toBe('Find the entry point and report its path.'); // fresh conversation: only the task
    const report = reportOf(t.messages)[0]; expect(report).toContain('Entry point is src/index.js'); expect(report).toContain('finished: complete');
    expect(types('subagent_start')[0]).toMatchObject({ id: 'S1', name: 'find entry', mode: 'plan', downgraded: false });
    expect(types('subagent_done')[0]).toMatchObject({ id: 'S1', status: 'complete' });
    expect(events.findIndex((e) => e.type === 'subagent_start')).toBeLessThan(events.findIndex((e) => e.type === 'subagent_done'));
    expect(events.some((e) => e.type === '_audit' && e.a[0] === 'agent.subagent')).toBe(true);
  });
  it('streams the child\'s steps tagged with its id (so the UI can nest them)', async () => {
    const t = setup({ mode: 'plan', parent: [[call('spawn_agent', { task: 'look', name: 'looker' }, 'S2')]],
      child: async (a) => (a.messages.length === 1 ? [{ type: 'text', text: 'peeking' }, call('list_dir', { path: '.' }, 'c1')] : [call('conclude', { summary: 'ok', status: 'complete' })]) });
    await t.run();
    const inner = types('subagent_event').filter((e) => e.id === 'S2').map((e) => e.event.type);
    expect(inner).toEqual(expect.arrayContaining(['text', 'tool_start', 'tool_result'])); expect(types('tool_start').map((e) => e.name)).toEqual(['spawn_agent']); // the child's calls are not top-level steps
  });
  it('falls back to the child\'s last words when it ends without calling conclude', async () => {
    const t = setup({ mode: 'plan', parent: [[call('spawn_agent', { task: 't' })]], child: async () => [{ type: 'text', text: 'plain answer' }] });
    await t.run(); expect(reportOf(t.messages)[0]).toContain('without a formal report'); expect(reportOf(t.messages)[0]).toContain('plain answer');
  });
  it('survives a child that crashes: the parent gets an error report and continues', async () => {
    const t = setup({ mode: 'plan', parent: [[call('spawn_agent', { task: 't' })], [{ type: 'text', text: 'carrying on' }]], child: async () => { throw new Error('model exploded'); } });
    const r = await t.run(); expect(r.stopped).toBe('complete'); expect(reportOf(t.messages)[0]).toMatch(/failed: model exploded/); expect(types('subagent_done')[0].status).toBe('blocked');
  });
  it('caps how many subagents one turn can start', async () => {
    const calls = Array.from({ length: MAX_SUBAGENTS_PER_TURN + 2 }, (_, i) => call('spawn_agent', { task: `t${i}` }, `P${i}`));
    const t = setup({ mode: 'plan', parent: [calls], child: async () => [call('conclude', { summary: 'ok', status: 'complete' })] });
    await t.run(); const out = reportOf(t.messages);
    expect(out.filter((r) => r.startsWith('Error: this turn already started')).length).toBe(2); expect(types('subagent_start')).toHaveLength(MAX_SUBAGENTS_PER_TURN);
  });
  it('rejects an empty task', async () => {
    const t = setup({ mode: 'plan', parent: [[call('spawn_agent', { task: '  ' })]], child: async () => [] }); await t.run(); expect(reportOf(t.messages)[0]).toMatch(/"task" is required/);
  });
});

describe('subagents never exceed the parent\'s authority', () => {
  const writer = (p) => async (a) => (a.messages.length === 1 ? [call('write_file', { path: p, content: 'x' }, 'w')] : [call('conclude', { summary: 'tried', status: 'complete' })]);
  it('a Plan-mode parent can only start read-only children, even if the model asks for act', async () => {
    const t = setup({ mode: 'plan', parent: [[call('spawn_agent', { task: 'edit things', mode: 'act' }, 'X')]], child: writer('pwn.txt') });
    await t.run();
    expect(types('subagent_start')[0]).toMatchObject({ mode: 'plan', downgraded: true }); expect(fs.existsSync(path.join(root, 'pwn.txt'))).toBe(false);
    expect(types('subagent_event').find((e) => e.event.type === 'tool_result' && e.event.name === 'write_file').event.result).toMatch(/Plan mode/);
    expect(await listCheckpoints(1, root, data)).toEqual([]);
  });
  it('an Act-mode parent without agent.act permission also gets read-only children', async () => {
    const t = setup({ mode: 'act', permissions: new Set(['agent.plan']), parent: [[call('spawn_agent', { task: 'edit', mode: 'act' })]], child: writer('pwn.txt') });
    await t.run(); expect(types('subagent_start')[0].mode).toBe('plan'); expect(fs.existsSync(path.join(root, 'pwn.txt'))).toBe(false);
  });
  it('an Act child may edit files, after a checkpoint, and reports what it changed', async () => {
    const t = setup({ mode: 'act', parent: [[call('spawn_agent', { task: 'create a.txt', mode: 'act', name: 'maker' })]],
      child: async (a) => (a.messages.length === 1 ? [call('write_file', { path: 'a.txt', content: 'made' }, 'w')] : [call('conclude', { summary: 'Created a.txt', status: 'complete', changes: ['a.txt'] })]) });
    await t.run();
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('made'); expect(types('subagent_start')[0].mode).toBe('act');
    expect((await listCheckpoints(1, root, data))[0].label).toBe('Before subagent: maker'); expect(reportOf(t.messages)[0]).toContain('Files changed: a.txt');
    expect(types('subagent_event').some((e) => e.event.type === 'file_changed' && e.event.path === 'a.txt')).toBe(true);
  });
  it('children cannot spawn further subagents, switch mode, or call tools they were not given', async () => {
    const t = setup({ mode: 'act', parent: [[call('spawn_agent', { task: 'try to escape' })]],
      child: async (a) => (a.messages.length === 1 ? [call('spawn_agent', { task: 'grandchild' }, 'g'), call('switch_mode', { mode: 'plan', reason: 'x' }, 's')] : [call('conclude', { summary: 'done', status: 'complete' })]) });
    await t.run();
    const results = types('subagent_event').filter((e) => e.event.type === 'tool_result' && ['spawn_agent', 'switch_mode'].includes(e.event.name)).map((e) => e.event.result);
    expect(results).toHaveLength(2); expect(results.every((r) => /^Error/.test(r))).toBe(true); expect(types('subagent_start')).toHaveLength(1);
  });
  it('shell commands from a child still go through the user\'s approval, labeled with the subagent', async () => {
    const asked = [];
    const t = setup({ mode: 'act', permissions: perms('agent.shell.run'), approve: async (cmd, who) => { asked.push([cmd, who]); return false; },
      parent: [[call('spawn_agent', { task: 'run tests', mode: 'act', name: 'tester' })]],
      child: async (a) => (a.messages.length === 1 ? [call('run_command', { command: 'npm test' }, 'rc')] : [call('conclude', { summary: 'could not run', status: 'blocked' })]) });
    t.ctx.execMode = 'workspace_shell';
    await t.run(); expect(asked).toEqual([['npm test', { agent: 'tester' }]]);
  });
});

describe('parallelism', () => {
  const slow = (ms) => async () => { await sleep(ms); return [call('conclude', { summary: 'ok', status: 'complete' })]; };
  it('runs read-only subagents from one message concurrently and returns reports in call order', async () => {
    const t = setup({ mode: 'plan', parent: [[call('spawn_agent', { task: 'A', name: 'a' }, 'A'), call('spawn_agent', { task: 'B', name: 'b' }, 'B'), call('spawn_agent', { task: 'C', name: 'c' }, 'C')]],
      child: async (a) => { await sleep(a.messages[0].content === 'A' ? 250 : 80); return [call('conclude', { summary: `report ${a.messages[0].content}`, status: 'complete' })]; } });
    const t0 = Date.now(); await t.run(); const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500); // sequential would be 410ms+; concurrent is ~250ms (+ overhead)
    expect(reportOf(t.messages).map((r) => /report (\w)/.exec(r)[1])).toEqual(['A', 'B', 'C']); // order of the calls, not of completion
    expect(types('subagent_done').map((e) => e.id)).toEqual(['B', 'C', 'A']); // B and C finished first
  });
  it('never runs more than the allowed number at once', async () => {
    let live = 0, peak = 0;
    const t = setup({ mode: 'plan', parent: [Array.from({ length: 6 }, (_, i) => call('spawn_agent', { task: `t${i}` }, `Q${i}`))],
      child: async () => { live += 1; peak = Math.max(peak, live); await sleep(60); live -= 1; return [call('conclude', { summary: 'ok', status: 'complete' })]; } });
    await t.run(); expect(peak).toBeLessThanOrEqual(3); expect(peak).toBeGreaterThan(1);
  });
  it('runs Act subagents one at a time (they edit the same project)', async () => {
    let live = 0, peak = 0;
    const t = setup({ mode: 'act', parent: [[call('spawn_agent', { task: 'a', mode: 'act' }, 'X1'), call('spawn_agent', { task: 'b', mode: 'act' }, 'X2')]],
      child: async () => { live += 1; peak = Math.max(peak, live); await sleep(80); live -= 1; return [call('conclude', { summary: 'ok', status: 'complete' })]; } });
    await t.run(); expect(peak).toBe(1);
  });
});

describe('model support is configurable', () => {
  it('administrators can turn subagents off per model without disturbing other settings, and the agent endpoint honors it', async () => {
    freshDb(); const modelId = addProvider();
    const seen = [];
    const factory = () => ({ async *stream(args) { seen.push(args.tools.map((t) => t.name)); yield { type: 'text', text: 'hi' }; yield { type: 'done' }; } });
    const app = createApp({ deps: { adapterFactory: factory } });
    const admin = login(app, { username: 'rootadmin', roles: ['administrator'] });
    const pid = getDb().prepare('SELECT provider_id p FROM models WHERE id=?').get(modelId).p;
    const listed = (await admin.get('/api/admin/providers')).body[0].models[0]; expect(listed.subagents).toBe(true);
    const turn = async () => { const p = (await admin.get('/api/projects')).body[0] || (await admin.post('/api/projects').send({ name: 'sa' })).body; await admin.post('/api/agent/turn').send({ projectId: p.id, message: 'x', mode: 'plan', modelId }).buffer(true).parse((r, cb) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => cb(null, d)); }); };
    await turn(); expect(seen.at(-1)).toContain('spawn_agent');
    const off = await admin.post(`/api/admin/providers/${pid}/models`).send({ modelId: 'fake-model', subagents: false, maxTokens: 4096 });
    expect(off.body.models[0]).toMatchObject({ subagents: false, enabled: true });
    await turn(); expect(seen.at(-1)).not.toContain('spawn_agent');
    const toggled = await admin.post(`/api/admin/providers/${pid}/models`).send({ modelId: 'fake-model', enabled: true }); // an update that omits the flag must not flip it back on
    expect(toggled.body.models[0].subagents).toBe(false);
  });
});
