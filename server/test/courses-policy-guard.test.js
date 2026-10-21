import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';
import { freshDb, createApp, login, makeRole } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { saveSettings, getSettings } from '../src/settings.js';
import { registry } from '../src/http.js';
import { TerminalManager } from '../src/terminal/manager.js';
import { attachTerminalWs } from '../src/terminal/ws.js';
import { PRESETS, deniedPermissions } from '../src/courses/policy.js';

let app; let inst; let stu; let mgr;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEARNER = ['project.read', 'project.write', 'project.delete', 'files.read', 'files.write', 'agent.plan', 'agent.act', 'agent.shell.run', 'terminal.use', 'git.commit', 'git.push', 'download.code', 'checkpoint.read', 'checkpoint.write', 'provider.use', 'course.learn', 'memory.use'];
beforeEach(() => {
  freshDb(); mgr = new TerminalManager({ idleMs: 50 });
  makeRole('learner', LEARNER);
  app = createApp({ deps: { terminals: mgr } });
  inst = login(app, { username: 'teacher1', roles: ['instructor'] });
  stu = login(app, { username: 'student1', roles: ['learner'] });
});
afterEach(() => mgr.killAll());

async function workspace(policy) {
  const course = (await inst.post('/api/courses').send({ title: 'G' })).body;
  await inst.put(`/api/courses/${course.id}`).send({ title: 'G', status: 'published' });
  await inst.post(`/api/courses/${course.id}/enrollments`).send({ type: 'user', id: stu.id });
  const quiz = (await inst.post(`/api/courses/${course.id}/assessments`).send({ title: 'E' })).body;
  await inst.post(`/api/courses/${course.id}/assessments/${quiz.id}/questions`).send({ type: 'exercise', prompt: 'p', spec: { brief: 'b', checks: [{ type: 'file_exists', label: 'x', points: 1, path: 'x' }], policy } });
  const att = (await stu.post(`/api/courses/${course.id}/assessments/${quiz.id}/attempts`)).body;
  return { course, att, pid: att.questions[0].exercise.workspace.projectId, submit: () => stu.post(`/api/courses/${course.id}/attempts/${att.id}/submit`).send({ answers: {} }) };
}
const dirOf = (pid) => getDb().prepare('SELECT dir FROM projects WHERE id=?').get(pid).dir;

describe('rules reach every project route', () => {
  it('a frozen workspace refuses every project route that changes things, and the test fails for any route nobody classified', async () => {
    const { pid, submit } = await workspace(PRESETS.guided); await submit();
    const denied = deniedPermissions(PRESETS.guided, { locked: true });
    const READ_ONLY = new Set(['project.read', 'files.read', 'checkpoint.read', 'project.delete']); // allowed on a frozen workspace
    const routes = registry.filter((r) => r.path.startsWith('/api/projects/:id'));
    expect(routes.length).toBeGreaterThan(15);
    const unclassified = [];
    for (const r of routes) {
      const perm = typeof r.access === 'string' ? r.access : r.access.perm;
      if (READ_ONLY.has(perm)) continue;
      if (!denied.has(perm)) { unclassified.push(`${r.method} ${r.path} (${perm})`); continue; }
      const url = r.path.replace(':id', pid).replace(/:\w+/g, '1');
      const res = await stu[r.method === 'DELETE' ? 'del' : r.method.toLowerCase()](url).send({});
      expect([r.method, r.path, res.status, res.body.error]).toEqual([r.method, r.path, 403, 'exercise_policy']);
    }
    expect(unclassified, 'these routes use a permission the exercise rules do not classify; decide whether a frozen workspace may use them').toEqual([]);
  });

  it('routes that take a projectId in the body or query are covered too, and new ones must be reviewed', async () => {
    const { pid, submit } = await workspace(PRESETS.full); await submit();
    for (const [m, url, body] of [['post', '/api/terminal/sessions', { projectId: pid }], ['post', '/api/terminal/kernel/run', { projectId: pid, path: 'a.ipynb', code: '1' }], ['get', `/api/agent/status?projectId=${pid}`], ['get', `/api/memory?projectId=${pid}`], ['post', '/api/agent/turn', { projectId: pid, message: 'x', mode: 'plan' }]]) {
      const res = await stu[m](url).send(body ?? {});
      expect([url, res.status, res.body.error]).toEqual([url, 403, 'exercise_policy']);
    }
    // Any route file that mentions projectId must be one of these, so a new one gets a look at how the rules apply to it.
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '../src/routes');
    const REVIEWED = ['agent.js', 'assessments.js', 'courses.js', 'kernel.js', 'memory.js', 'projects.js', 'reports.js', 'sessions.js', 'terminal.js'];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && /projectId/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(files.filter((f) => !REVIEWED.includes(f)), 'a route file that uses projectId is new: check how exercise rules apply, then add it here').toEqual([]);
  });
});

describe('an exercise in progress', () => {
  it('Guided keeps editing and checkpoints but takes away git, downloads and the terminal', async () => {
    const { pid } = await workspace(PRESETS.guided);
    expect((await stu.put(`/api/projects/${pid}/file`).send({ path: 'a.txt', content: 'hi' })).status).toBe(200);
    expect((await stu.get(`/api/projects/${pid}/download`)).body.error).toBe('exercise_policy');
    expect((await stu.post(`/api/projects/${pid}/git/commit`).send({ message: 'x' })).body.error).toBe('exercise_policy');
    expect((await stu.post('/api/terminal/sessions').send({ projectId: pid })).body.error).toBe('exercise_policy');
    expect((await stu.get(`/api/projects/${pid}/checkpoints`)).status).toBe(200);
  });
  it('protected files and folders cannot be edited, moved, deleted or replaced through the file API', async () => {
    const { pid } = await workspace({ ...PRESETS.guided, protectedFiles: ['tests', 'answer.txt'] });
    const dir = dirOf(pid); fs.mkdirSync(path.join(dir, 'tests/deep'), { recursive: true }); fs.writeFileSync(path.join(dir, 'tests/deep/t.js'), 'orig'); fs.writeFileSync(path.join(dir, 'answer.txt'), 'orig');
    const code = async (r) => (await r).body.error;
    expect(await code(stu.put(`/api/projects/${pid}/file`).send({ path: 'tests/deep/t.js', content: 'x' }))).toBe('protected_file');
    expect(await code(stu.put(`/api/projects/${pid}/file`).send({ path: 'tests/new.js', content: 'x' }))).toBe('protected_file');
    expect(await code(stu.put(`/api/projects/${pid}/file`).send({ path: 'answer.txt', content: 'x' }))).toBe('protected_file');
    expect(await code(stu.del(`/api/projects/${pid}/file?path=tests`))).toBe('protected_file'); // a folder that holds a protected file
    expect(await code(stu.post(`/api/projects/${pid}/rename`).send({ from: 'tests', to: 'moved' }))).toBe('protected_file');
    expect(await code(stu.post(`/api/projects/${pid}/rename`).send({ from: 'a.txt', to: 'tests/a.txt' }))).toBe('protected_file');
    expect(fs.readFileSync(path.join(dir, 'tests/deep/t.js'), 'utf8')).toBe('orig');
    expect((await stu.put(`/api/projects/${pid}/file`).send({ path: 'app.js', content: 'fine' })).status).toBe(200);
    expect((await stu.get(`/api/projects/${pid}/file?path=answer.txt`)).body.content).toBe('orig'); // reading is allowed
  });
  it('after submit the learner can still read the workspace but not change it', async () => {
    const { pid, submit } = await workspace(PRESETS.full);
    await stu.put(`/api/projects/${pid}/file`).send({ path: 'a.txt', content: 'mine' });
    await submit();
    expect((await stu.put(`/api/projects/${pid}/file`).send({ path: 'a.txt', content: 'changed' })).body.error).toBe('exercise_policy');
    expect((await stu.get(`/api/projects/${pid}/file?path=a.txt`)).body.content).toBe('mine');
    expect((await stu.get(`/api/projects/${pid}/tree`)).status).toBe(200);
  });
  it('ordinary projects ignore all of this', async () => {
    await workspace(PRESETS.plan_only);
    const p = (await stu.post('/api/projects').send({ name: 'mine' })).body;
    expect((await stu.put(`/api/projects/${p.id}/file`).send({ path: 'a.txt', content: 'x' })).status).toBe(200);
    expect((await stu.post(`/api/projects/${p.id}/git/commit`).send({ message: 'm' })).body.error).not.toBe('exercise_policy');
  });
});

describe('showing the rules', () => {
  it('tells the IDE about a workspace\'s rules, and nothing for an ordinary project', async () => {
    const { pid, att, submit } = await workspace({ ...PRESETS.guided, timeLimitMin: 30 });
    const ordinary = (await stu.post('/api/projects').send({ name: 'mine' })).body;
    expect((await stu.get(`/api/projects/${ordinary.id}/exercise-policy`)).body).toBeNull();
    const rules = (await stu.get(`/api/projects/${pid}/exercise-policy`)).body;
    expect(rules).toMatchObject({ mode: 'act', shell: false, locked: false, deadline: expect.any(Number) });
    expect(rules.summary.join(' ')).toMatch(/must propose a plan/);
    expect(att.questions[0].exercise.rules.join(' ')).toMatch(/30 minutes/); // learners read the rules before they start
    await submit();
    expect((await stu.get(`/api/projects/${pid}/exercise-policy`)).body).toMatchObject({ locked: true, submitted: true });
    const other = login(app, { username: 'student2', roles: ['learner'] });
    expect((await other.get(`/api/projects/${pid}/exercise-policy`)).status).toBe(404);
  });
  it('previews what a role could do under a set of rules', async () => {
    const preview = (policy, role = 'learner') => inst.post('/api/courses-policy-preview').send({ policy, role });
    const res = (await preview(PRESETS.plan_only)).body;
    const ability = (label) => res.abilities.find((a) => a.label === label);
    expect(ability('Let the agent change files')).toMatchObject({ role: true, allowed: false });
    expect(ability('Plan with the agent')).toMatchObject({ role: true, allowed: true });
    expect(ability('Git push')).toMatchObject({ role: true, allowed: false });
    expect(ability('Web search')).toMatchObject({ role: false, allowed: false }); // the role never had it; rules cannot add it
    expect((await preview(PRESETS.plan_only, 'nope')).status).toBe(400);
    expect((await preview({ ...PRESETS.guided, shell: true, protectedFiles: ['tests'] })).status).toBe(400);
    expect((await stu.post('/api/courses-policy-preview').send({ policy: PRESETS.guided, role: 'learner' })).status).toBe(403);
    expect((await inst.get('/api/courses-roles')).body).toContain('learner');
  });
});

describe('terminal WebSocket', () => {
  let server; let port;
  const connect = (id) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws?id=${id}`, { headers: { Cookie: stu.cookie, Origin: `http://127.0.0.1:${port}` } });
    const msgs = []; ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, msgs, status: 101 })); ws.on('unexpected-response', (_q, res) => resolve({ ws, msgs, status: res.statusCode })); ws.on('error', () => {});
  });
  beforeEach(async () => {
    saveSettings('general', { ...getSettings('general'), execMode: 'workspace_shell' });
    server = http.createServer(app); attachTerminalWs(server, { manager: mgr, sweepMs: 100 }); await new Promise((r) => server.listen(0, r)); port = server.address().port;
  });
  afterEach(() => new Promise((r) => { mgr.killAll(); server.closeAllConnections?.(); server.close(r); }));

  it('a Full exercise gets a terminal; submitting ends the connection and blocks reconnecting', async () => {
    const { pid, submit } = await workspace(PRESETS.full);
    const id = (await stu.post('/api/terminal/sessions').send({ projectId: pid })).body.id;
    const c = await connect(id); expect(c.status).toBe(101);
    await submit(); await sleep(500);
    expect(c.msgs.some((m) => m.type === 'closed' && m.reason === 'access_revoked')).toBe(true);
    expect((await connect(id)).status).toBe(404);
  });
  it('a terminal that was opened before the rules took the shell away (a time limit) cannot be attached', async () => {
    const { att, pid } = await workspace({ ...PRESETS.full, timeLimitMin: 5 });
    const id = (await stu.post('/api/terminal/sessions').send({ projectId: pid })).body.id;
    expect((await connect(id)).status).toBe(101);
    getDb().prepare('UPDATE attempts SET started_at=started_at-900 WHERE id=?').run(att.id);
    expect((await connect(id)).status).toBe(404);
  });
});
