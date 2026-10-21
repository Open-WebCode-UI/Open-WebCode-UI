import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, createApp, login, addProvider, fakeAdapterFactory } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { PRESETS } from '../src/courses/policy.js';
import { getToolsFor } from '../src/agent/tools.js';

const parseSse = (t) => t.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
const turn = (u, body) => u.post('/api/agent/turn').send(body).buffer(true).parse((res, cb) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => cb(null, d)); });

let modelId; let seen; let inst; let stu; let app; let course; let quiz;
function setup(script = []) {
  freshDb(); modelId = addProvider(); seen = [];
  app = createApp({ deps: { adapterFactory: fakeAdapterFactory(script, seen) } });
  inst = login(app, { username: 'teacher1', roles: ['instructor'] });
  stu = login(app, { username: 'student1', roles: ['developer'] });
}
// An exercise with the given rules, started by the learner; returns the workspace project and attempt.
async function exercise(policy) {
  course = (await inst.post('/api/courses').send({ title: 'Rules' })).body;
  await inst.put(`/api/courses/${course.id}`).send({ title: 'Rules', status: 'published' });
  await inst.post(`/api/courses/${course.id}/enrollments`).send({ type: 'user', id: stu.id });
  quiz = (await inst.post(`/api/courses/${course.id}/assessments`).send({ title: 'E' })).body;
  const r = await inst.post(`/api/courses/${course.id}/assessments/${quiz.id}/questions`).send({ type: 'exercise', prompt: 'Do it', spec: { brief: 'b', checks: [{ type: 'file_exists', label: 'x', points: 1, path: 'x.txt' }], policy } });
  expect(r.status).toBe(201);
  const att = (await stu.post(`/api/courses/${course.id}/assessments/${quiz.id}/attempts`)).body;
  return { att, pid: att.questions[0].exercise.workspace.projectId };
}
const act = (pid, extra = {}) => ({ projectId: pid, message: 'go', mode: 'act', modelId, ...extra });
const startOf = (res) => parseSse(res.body).find((e) => e.type === 'start');

describe('agent turns in an exercise workspace', () => {
  it('Plan only refuses Act, even when the request claims it, and still plans', async () => {
    setup([[{ type: 'text', text: 'plan' }]]);
    const { pid } = await exercise(PRESETS.plan_only);
    const denied = await turn(stu, act(pid));
    expect(denied.status).toBe(403); expect(JSON.parse(denied.body)).toMatchObject({ error: 'exercise_policy', reason: 'mode' });
    expect((await turn(stu, { ...act(pid), mode: 'plan' })).status).toBe(200);
    expect(seen[0].tools).not.toContain('spawn_agent'); // subagents are off in every preset but Full
    expect(getDb().prepare("SELECT COUNT(*) c FROM audit WHERE action='exercise.policy_denied'").get().c).toBe(1);
  });

  it('Guided needs a plan the agent proposed before Act, takes away the shell, and consumes the plan', async () => {
    setup([[{ type: 'tool_call', id: 'p1', name: 'propose_plan', args: { plan: '# Plan\n1. write notes' } }], [{ type: 'text', text: 'done' }], [{ type: 'text', text: 'again' }]]);
    const { pid } = await exercise(PRESETS.guided);
    const no = await turn(stu, act(pid));
    expect(JSON.parse(no.body)).toMatchObject({ error: 'plan_required' });
    expect(JSON.parse((await turn(stu, act(pid, { conversationId: 9999 }))).body).error).toBe('plan_required'); // someone else's or missing session
    const planned = await turn(stu, { ...act(pid), mode: 'plan' });
    const cid = startOf(planned).conversationId;
    // a plan typed into the request is not enough: the server remembers the plan the agent proposed
    expect((await turn(stu, act(pid, { approvedPlan: 'trust me' }))).status).toBe(403);
    const ok = await turn(stu, act(pid, { conversationId: cid, approvedPlan: '# Plan\n1. write notes' }));
    expect(ok.status).toBe(200);
    const offered = seen.at(-1).tools;
    expect(offered).toContain('write_file'); expect(offered).not.toContain('run_command');
    expect((await turn(stu, act(pid, { conversationId: cid }))).status).toBe(403); // the plan was used up
    expect((await turn(stu, act(pid, { conversationId: cid, resume: true }))).status).toBe(200); // continuing an Act turn that had one
  });

  it('after submit the workspace is frozen for the agent, and so is a lapsed time limit', async () => {
    setup([[{ type: 'text', text: 'ok' }]]);
    const { att, pid } = await exercise({ ...PRESETS.full, timeLimitMin: 5 });
    expect((await turn(stu, act(pid))).status).toBe(200);
    getDb().prepare('UPDATE attempts SET started_at=started_at-600 WHERE id=?').run(att.id);
    expect(JSON.parse((await turn(stu, act(pid))).body)).toMatchObject({ error: 'exercise_policy', reason: 'time_limit' });
    getDb().prepare('UPDATE attempts SET started_at=started_at+600 WHERE id=?').run(att.id);
    await stu.post(`/api/courses/${course.id}/attempts/${att.id}/submit`).send({ answers: {} });
    expect(JSON.parse((await turn(stu, act(pid))).body)).toMatchObject({ reason: 'submitted' });
  });

  it('stops at the message limit and the spending limit', async () => {
    setup([[{ type: 'text', text: 'one' }]]);
    const { pid } = await exercise({ ...PRESETS.full, maxMessages: 1, maxCost: 1 });
    const first = await turn(stu, act(pid));
    expect(first.status).toBe(200);
    expect((await turn(stu, act(pid))).status).toBe(429);
    expect(JSON.parse((await turn(stu, act(pid))).body).error).toBe('exercise_message_limit');
    getDb().prepare('DELETE FROM messages').run(); // pretend the messages are not the problem; now only spend is
    getDb().prepare("INSERT INTO usage (conversation_id, kind, cost) VALUES (?, 'agent', 2)").run(startOf(first).conversationId);
    expect(JSON.parse((await turn(stu, act(pid))).body).error).toBe('exercise_budget_exceeded');
  });

  it('caps agent steps per message and pins the model whatever the browser asks for', async () => {
    setup([[{ type: 'tool_call', id: 't1', name: 'list_dir', args: { path: '.' } }], [{ type: 'tool_call', id: 't2', name: 'list_dir', args: { path: '.' } }], [{ type: 'text', text: 'never reached' }]]);
    const pinned = Number(getDb().prepare("INSERT INTO models (provider_id, model_id, label) VALUES (1, 'fake-model-2', 'Pinned')").run().lastInsertRowid);
    const { pid } = await exercise({ ...PRESETS.full, maxSteps: 1, modelId: pinned });
    const res = await turn(stu, act(pid));
    expect(seen).toHaveLength(1); expect(res.body).toMatch(/maximum number of steps/);
    expect(getDb().prepare('SELECT model_row_id FROM usage ORDER BY id DESC').get().model_row_id).toBe(pinned);
  });

  it('protected files cannot be changed by the agent, but other files can', async () => {
    setup([[{ type: 'tool_call', id: 'a', name: 'write_file', args: { path: 'tests/check.js', content: 'cheat' } }, { type: 'tool_call', id: 'b', name: 'write_file', args: { path: 'app.js', content: 'ok' } }, { type: 'tool_call', id: 'c', name: 'delete_file', args: { path: 'tests' } }], [{ type: 'text', text: 'done' }]]);
    const { pid } = await exercise({ ...PRESETS.guided, requirePlan: false, protectedFiles: ['tests'] });
    const dir = getDb().prepare('SELECT dir FROM projects WHERE id=?').get(pid).dir;
    fs.mkdirSync(path.join(dir, 'tests')); fs.writeFileSync(path.join(dir, 'tests/check.js'), 'original');
    const res = parseSse((await turn(stu, act(pid))).body).filter((e) => e.type === 'tool_result');
    expect(res[0].result).toMatch(/protected by this exercise/); expect(res[2].result).toMatch(/protected by this exercise/);
    expect(fs.readFileSync(path.join(dir, 'tests/check.js'), 'utf8')).toBe('original');
    expect(fs.readFileSync(path.join(dir, 'app.js'), 'utf8')).toBe('ok');
  });

  it('ordinary projects are not affected by any exercise rules', async () => {
    setup([[{ type: 'text', text: 'fine' }]]);
    await exercise(PRESETS.plan_only);
    const p = (await stu.post('/api/projects').send({ name: 'mine' })).body;
    expect((await turn(stu, act(p.id))).status).toBe(200);
  });
});

describe('tool denial', () => {
  const ctx = { execMode: 'files_only', agentMode: 'act', permissions: new Set(['agent.act']), subagents: true, skills: [{ name: 's' }] };
  it('never offers a denied tool, and leaves the rest alone', () => {
    const all = getToolsFor(ctx).map((t) => t.name);
    expect(all).toContain('spawn_agent'); expect(all).toContain('use_skill');
    const some = getToolsFor({ ...ctx, toolDeny: new Set(['spawn_agent', 'use_skill']) }).map((t) => t.name);
    expect(some).not.toContain('spawn_agent'); expect(some).not.toContain('use_skill'); expect(some).toContain('write_file');
  });
});
