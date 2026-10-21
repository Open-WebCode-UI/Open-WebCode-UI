import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, createApp, login, makeRole } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { config } from '../src/config.js';
import { runChecks } from '../src/courses/exercises.js';

let app; let inst; let stu; let course; let quiz;
const A = () => `/api/courses/${course.id}/assessments`;
const spec = (over = {}) => ({
  brief: 'Use the agent to add a notes file about testing.',
  starterFiles: [{ path: 'README.md', content: '# Starter\n' }],
  checks: [
    { type: 'file_exists', label: 'Notes file created', points: 2, path: 'notes.md' },
    { type: 'file_contains', label: 'Notes mention tests', points: 2, path: 'notes.md', text: 'TESTS', ignoreCase: true },
    { type: 'file_changed', label: 'README updated', points: 1, path: 'README.md' },
    { type: 'file_missing', label: 'No scratch file left', points: 1, path: 'tmp.txt' },
    { type: 'used_tool', label: 'Planned before acting', points: 2, tool: 'propose_plan' },
    { type: 'prompt_mentions', label: 'Asked about tests', points: 1, text: 'tests' },
  ],
  rubric: [{ label: 'Clear, specific prompts', points: 4 }], ...over,
});
const exercise = (s = spec()) => ({ type: 'exercise', prompt: 'Agentic exercise', spec: s });
async function setup(s) { const q = (await inst.post(`${A()}/${quiz.id}/questions`).send(exercise(s))).body; return q; }
const start = async (u = stu) => (await u.post(`${A()}/${quiz.id}/attempts`)).body;
const submit = (u, att) => u.post(`/api/courses/${course.id}/attempts/${att.id}/submit`).send({ answers: {} });
const projectDir = (id) => getDb().prepare('SELECT dir FROM projects WHERE id=?').get(id).dir;
// What the learner's agent session would leave behind: a conversation in the workspace project.
function fakeSession(projectId, userId, { prompt, tools = [] }) {
  const db = getDb();
  const cid = Number(db.prepare("INSERT INTO conversations (user_id, project_id, kind, title) VALUES (?,?,'agent','s')").run(userId, projectId).lastInsertRowid);
  const ins = db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)');
  ins.run(cid, 'user', JSON.stringify({ role: 'user', content: prompt }));
  ins.run(cid, 'assistant', JSON.stringify({ role: 'assistant', content: 'Here is the plan.', toolCalls: tools.map((name, i) => ({ id: `t${i}`, name, args: { path: 'notes.md' } })) }));
}

beforeEach(async () => {
  freshDb(); app = createApp();
  inst = login(app, { username: 'teacher1', roles: ['instructor'] });
  stu = login(app, { username: 'student1', roles: ['developer'] });
  course = (await inst.post('/api/courses').send({ title: 'Agentic' })).body;
  await inst.put(`/api/courses/${course.id}`).send({ title: 'Agentic', status: 'published' });
  await inst.post(`/api/courses/${course.id}/enrollments`).send({ type: 'user', id: stu.id });
  quiz = (await inst.post(A()).send({ title: 'Exercise 1' })).body;
});

describe('exercise authoring', () => {
  it('totals points from checks and rubric, and shows learners the criteria but not the check parameters', async () => {
    const q = await setup();
    expect(q).toMatchObject({ type: 'exercise', points: 13 });
    const att = await start();
    const ex = att.questions[0].exercise;
    expect(ex.brief).toMatch(/notes file/); expect(ex.criteria).toHaveLength(7);
    expect(ex.criteria.at(-1)).toEqual({ label: 'Clear, specific prompts', points: 4, kind: 'rubric' });
    expect(JSON.stringify(att)).not.toMatch(/notes\.md|starterFiles|ignoreCase|"text":"TESTS"/);
    expect(ex).toMatchObject({ canUseAgent: true, workspace: { projectId: expect.any(Number) } });
  });
  it('rejects unsafe or empty specs', async () => {
    const bad = async (s) => (await inst.post(`${A()}/${quiz.id}/questions`).send(exercise(s))).status;
    expect(await bad(spec({ starterFiles: [{ path: '../evil', content: 'x' }] }))).toBe(400);
    expect(await bad(spec({ starterFiles: [{ path: '/etc/passwd', content: 'x' }] }))).toBe(400);
    expect(await bad(spec({ starterFiles: [{ path: '.git/config', content: 'x' }] }))).toBe(400);
    expect(await bad(spec({ checks: [{ type: 'file_exists', label: 'x', points: 1, path: 'a/../../b' }] }))).toBe(400);
    expect(await bad(spec({ checks: [{ type: 'run_command', label: 'x', points: 1, command: 'rm -rf /' }], rubric: [] }))).toBe(400);
    expect(await bad(spec({ checks: [{ type: 'used_tool', label: 'x', points: 1, tool: 'not_a_tool' }] }))).toBe(400);
    expect(await bad(spec({ checks: [], rubric: [] }))).toBe(400);
    expect(await bad(spec({ checks: [], rubric: [{ label: 'ok', points: 2 }] }))).toBe(201);
  });
});

describe('an exercise attempt', () => {
  it('seeds a workspace owned by the learner, then checks the result and waits for the rubric', async () => {
    const q = await setup();
    const att = await start();
    const pid = att.questions[0].exercise.workspace.projectId;
    expect(fs.readFileSync(path.join(projectDir(pid), 'README.md'), 'utf8')).toBe('# Starter\n');
    expect((await stu.get('/api/projects')).body.map((p) => p.id)).toContain(pid); // the learner opens it like any project
    expect((await start()).id).toBe(att.id); // resuming does not create another workspace
    expect(getDb().prepare('SELECT COUNT(*) n FROM exercise_workspaces').get().n).toBe(1);

    await stu.put(`/api/projects/${pid}/file`).send({ path: 'notes.md', content: 'Always add tests first.' });
    await stu.put(`/api/projects/${pid}/file`).send({ path: 'README.md', content: '# Changed\n' });
    fakeSession(pid, stu.id, { prompt: 'Please write tests for the parser', tools: ['propose_plan', 'write_file'] });

    const res = (await submit(stu, att)).body;
    const ans = res.questions[0];
    expect(ans.response.checks.map((c) => c.passed)).toEqual([true, true, true, true, true, true]);
    expect(ans.response.autoScore).toBe(9);
    expect(res).toMatchObject({ status: 'submitted', score: 69.2 }); // 9 of 13 so far; rubric pending
    expect(ans.earned).toBeNull();

    // instructor reviews the evidence
    const base = `/api/courses/${course.id}/attempts/${att.id}/exercises/${q.id}`;
    expect((await inst.get(`${base}/files`)).body.files.map((f) => f.path)).toEqual(['notes.md', 'README.md']);
    expect((await inst.get(`${base}/file?path=notes.md`)).body.content).toBe('Always add tests first.');
    const tr = (await inst.get(`${base}/transcript`)).body.messages;
    expect(tr.map((m) => m.role)).toEqual(['user', 'assistant']); expect(tr[1].tools.map((t) => t.name)).toEqual(['propose_plan', 'write_file']);
    expect((await stu.get(`${base}/files`)).status).toBe(403);
    expect((await inst.get(`${base}/file?path=../../../etc/hosts`)).status).toBe(404);

    // rubric grading finishes the attempt
    const gr = (b) => inst.put(`/api/courses/${course.id}/attempts/${att.id}/answers/${q.id}/grade`).send(b);
    expect((await gr({ rubric: [] })).status).toBe(400); expect((await gr({ rubric: [5] })).status).toBe(400);
    const done = (await gr({ rubric: [3], feedback: 'Good prompts' })).body;
    expect(done).toMatchObject({ status: 'graded', score: 92.3, passed: true });
    expect(done.questions[0]).toMatchObject({ earned: 12, feedback: 'Good prompts' });
    expect(done.questions[0].response.rubricScores).toEqual([3]);
  });

  it('with no rubric the exercise is graded at submit', async () => {
    await setup(spec({ rubric: [] }));
    expect((await inst.put(`${A()}/${quiz.id}`).send({ title: 'Exercise 1', passPct: 50 })).status).toBe(200); // allowed: every check is automatic
    const att = await start();
    const res = (await submit(stu, att)).body; // nothing done: only the "no scratch file" check passes
    expect(res).toMatchObject({ status: 'graded', score: 11.1, passed: false });
  });

  it('cannot be graded from the browser: whatever the request claims is ignored', async () => {
    await setup(spec({ rubric: [] }));
    const att = await start();
    const res = (await stu.post(`/api/courses/${course.id}/attempts/${att.id}/submit`).send({ answers: { [att.questions[0].id]: { checks: [{ passed: true }], autoScore: 99, text: 'x' } } })).body;
    expect(res.score).toBe(11.1);
  });

  it('survives a deleted workspace: checks fail, nothing crashes', async () => {
    await setup(spec({ rubric: [] }));
    const att = await start();
    fs.rmSync(projectDir(att.questions[0].exercise.workspace.projectId), { recursive: true, force: true });
    const res = (await submit(stu, att)).body;
    expect(res.questions[0].response.checks.every((c) => !c.passed)).toBe(true); // even "file missing" does not pass for a workspace that is gone
    expect(res.status).toBe('graded');
  });

  it('does not read through symlinks that point outside the workspace', async () => {
    await setup(spec({ checks: [{ type: 'file_contains', label: 'Link', points: 1, path: 'link.txt', text: 'localhost' }, { type: 'file_exists', label: 'Real', points: 1, path: 'README.md' }], rubric: [] }));
    const att = await start(); const dir = projectDir(att.questions[0].exercise.workspace.projectId);
    fs.symlinkSync('/etc/hosts', path.join(dir, 'link.txt'));
    const res = (await submit(stu, att)).body;
    expect(res.questions[0].response.checks.map((c) => c.passed)).toEqual([false, true]);
    expect(fs.existsSync(path.join(config.dataDir, 'course-submissions', String(att.id), String(att.questions[0].id), 'files', 'link.txt'))).toBe(false);
  });

  it('tells a learner without agent access, but the attempt still works', async () => {
    makeRole('viewer', ['course.learn']);
    const v = login(app, { username: 'viewer1', roles: ['viewer'] });
    await inst.post(`/api/courses/${course.id}/enrollments`).send({ type: 'user', id: v.id });
    await setup(spec({ rubric: [] }));
    const att = await start(v);
    expect(att.questions[0].exercise.canUseAgent).toBe(false);
    expect((await submit(v, att)).status).toBe(200);
  });

  it('removes submitted evidence when the assessment is deleted', async () => {
    const q = await setup(); const att = await start(); await submit(stu, att);
    const dir = path.join(config.dataDir, 'course-submissions', String(att.id));
    expect(fs.existsSync(dir)).toBe(true);
    expect((await inst.del(`${A()}/${quiz.id}`)).status).toBe(200);
    expect(fs.existsSync(dir)).toBe(false); expect(q.id).toBeTruthy();
  });
});

describe('check evaluation', () => {
  it('matches text case-sensitively unless asked, and counts tool calls against a minimum', () => {
    const dir = fs.mkdtempSync(path.join(config.dataDir, 'chk-')); fs.writeFileSync(path.join(dir, 'a.txt'), 'Hello World');
    const tx = [{ role: 'assistant', content: '', tools: [{ name: 'edit_file' }, { name: 'edit_file' }] }, { role: 'user', content: 'Add TESTS please' }];
    const r = runChecks({ starterFiles: [], rubric: [], checks: [
      { type: 'file_contains', label: 'a', points: 1, path: 'a.txt', text: 'hello', ignoreCase: false },
      { type: 'file_contains', label: 'b', points: 1, path: 'a.txt', text: 'hello', ignoreCase: true },
      { type: 'file_not_contains', label: 'c', points: 1, path: 'a.txt', text: 'bye' },
      { type: 'used_tool', label: 'd', points: 1, tool: 'edit_file', min: 2 }, { type: 'used_tool', label: 'e', points: 1, tool: 'edit_file', min: 3 },
      { type: 'prompt_mentions', label: 'f', points: 1, text: 'tests' }, { type: 'file_exists', label: 'g', points: 1, path: '.git/config' },
    ] }, { dir, transcript: tx });
    expect(r.map((x) => x.passed)).toEqual([false, true, true, true, false, true, false]);
  });
});
