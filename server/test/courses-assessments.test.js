import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, login } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { gradeAuto, cleanResponse, percent } from '../src/courses/grading.js';

let app; let inst; let stu; let other; let course; let page; let quiz;
const A = (c = course) => `/api/courses/${c.id}/assessments`;
const mcq = { type: 'mcq', prompt: 'Pick the primes', options: ['2', '4', '5'], correct: [0, 2], points: 2 };
const single = { type: 'mcq', prompt: 'Capital of France', options: ['Paris', 'Rome'], correct: [0] };
const tf = { type: 'tf', prompt: 'Water is wet', correct: true };
const text = { type: 'text', prompt: 'Explain scope', rubric: 'Mentions blocks', points: 4 };
async function addQ(q) { return (await inst.post(`${A()}/${quiz.id}/questions`).send(q)).body; }
const qs = async () => (await inst.get(`${A()}/manage`)).body.find((a) => a.id === quiz.id).questions;
async function attempt(u = stu) { return (await u.post(`${A()}/${quiz.id}/attempts`)).body; }

beforeEach(async () => {
  freshDb(); app = createApp();
  inst = login(app, { username: 'teacher1', roles: ['instructor'] });
  other = login(app, { username: 'teacher2', roles: ['instructor'] });
  stu = login(app, { username: 'student1', roles: ['developer'] });
  course = (await inst.post('/api/courses').send({ title: 'Quizzes' })).body;
  await inst.put(`/api/courses/${course.id}`).send({ title: 'Quizzes', status: 'published' });
  page = (await inst.post(`/api/courses/${course.id}/pages`).send({ title: 'P1' })).body;
  await inst.post(`/api/courses/${course.id}/enrollments`).send({ type: 'user', id: stu.id });
  quiz = (await inst.post(A()).send({ title: 'Quiz 1' })).body;
});
const setPass = (passPct) => inst.put(`${A()}/${quiz.id}`).send({ title: 'Quiz 1', passPct });

describe('grading rules', () => {
  const q = (type, key, over = {}) => ({ type, options_json: JSON.stringify(over.options || []), answer_key_json: JSON.stringify(key), points: over.points || 1 });
  it('multiple choice is all-or-nothing, true/false compares, text waits', () => {
    const m = q('mcq', { correct: [0, 2] }, { options: ['a', 'b', 'c'], points: 3 });
    expect(gradeAuto(m, { choices: [0, 2] })).toBe(3); expect(gradeAuto(m, { choices: [0] })).toBe(0); expect(gradeAuto(m, null)).toBe(0);
    expect(gradeAuto(q('tf', { correct: false }), { value: false })).toBe(1);
    expect(gradeAuto(q('text', { rubric: '' }), { text: 'x' })).toBeNull();
    expect(percent(1, 3)).toBe(33.3); expect(percent(0, 0)).toBe(0);
  });
  it('rejects malformed responses', () => {
    const m = q('mcq', { correct: [0] }, { options: ['a', 'b'] });
    expect(() => cleanResponse(m, { choices: [5] })).toThrow(); expect(() => cleanResponse(m, { choices: [0, 1] })).toThrow();
    expect(() => cleanResponse(q('tf', { correct: true }), { value: 'yes' })).toThrow();
    expect(cleanResponse(q('text', {}), { text: '   ' })).toBeNull();
  });
});

describe('assessment authoring', () => {
  it('builds questions of each type and never shows keys to learners', async () => {
    for (const x of [mcq, single, tf, text]) expect((await inst.post(`${A()}/${quiz.id}/questions`).send(x)).status).toBe(201);
    expect((await qs()).map((x) => x.type)).toEqual(['mcq', 'mcq', 'tf', 'text']);
    expect((await qs())[0]).toMatchObject({ correct: [0, 2], points: 2 });
    const att = await attempt();
    expect(JSON.stringify(att)).not.toMatch(/correct|rubric/);
    expect(att.questions[0]).toMatchObject({ multi: true }); expect(att.questions[1]).toMatchObject({ multi: false });
    const summary = (await stu.get(A())).body[0];
    expect(summary).toMatchObject({ questionCount: 4, totalPoints: 8, attemptsUsed: 0, inProgress: true });
    expect(JSON.stringify(summary)).not.toMatch(/correct/);
  });
  it('validates questions, and only authors of the course may change them', async () => {
    expect((await inst.post(`${A()}/${quiz.id}/questions`).send({ ...mcq, correct: [5] })).status).toBe(400);
    expect((await inst.post(`${A()}/${quiz.id}/questions`).send({ ...mcq, options: ['only'] })).status).toBe(400);
    expect((await inst.post(`${A()}/${quiz.id}/questions`).send({ type: 'exercise', prompt: 'x' })).status).toBe(400);
    expect((await other.post(`${A()}/${quiz.id}/questions`).send(tf)).status).toBe(404);
    expect((await stu.post(`${A()}/${quiz.id}/questions`).send(tf)).status).toBe(403);
    expect((await stu.get(`${A()}/manage`)).status).toBe(403);
    expect((await inst.post(A()).send({ title: 'x', moduleId: 9999 })).status).toBe(404);
  });
  it('locks questions once someone has attempted, but title and settings stay editable', async () => {
    const q1 = await addQ(tf); await attempt();
    expect((await inst.post(`${A()}/${quiz.id}/questions`).send(tf)).status).toBe(409);
    expect((await inst.put(`${A()}/${quiz.id}/questions/${q1.id}`).send({ ...tf, correct: false })).status).toBe(409);
    expect((await inst.del(`${A()}/${quiz.id}/questions/${q1.id}`)).status).toBe(409);
    expect((await inst.put(`${A()}/${quiz.id}`).send({ title: 'Renamed', maxAttempts: 2 })).status).toBe(200);
  });
  it('edits, reorders and deletes questions before any attempt', async () => {
    const a = await addQ(tf); const b = await addQ(single);
    expect((await inst.put(`${A()}/${quiz.id}/questions/${a.id}`).send({ ...tf, correct: false })).body.correct).toBe(false);
    expect((await inst.put(`${A()}/${quiz.id}/questions-order`).send({ ids: [b.id, a.id] })).status).toBe(200);
    expect((await qs()).map((x) => x.id)).toEqual([b.id, a.id]);
    expect((await inst.put(`${A()}/${quiz.id}/questions-order`).send({ ids: [a.id] })).status).toBe(400);
    expect((await inst.del(`${A()}/${quiz.id}/questions/${a.id}`)).status).toBe(200);
  });
});

describe('taking an assessment', () => {
  it('grades automatically, passes, and completes the attached page', async () => {
    const m = await addQ(mcq); const t = await addQ(tf); // 2 + 1 points, pass at 60%
    await setPass(60);
    expect((await stu.get(`/api/courses/${course.id}`)).body.completed).toEqual([]);
    const att = await attempt();
    const res = (await stu.post(`/api/courses/${course.id}/attempts/${att.id}/submit`).send({ answers: { [m.id]: { choices: [0, 2] }, [t.id]: { value: false } } })).body;
    expect(res).toMatchObject({ status: 'graded', score: 66.7, passed: true });
    expect(res.questions.map((x) => x.earned)).toEqual([2, 0]);
    expect(JSON.stringify(res)).not.toMatch(/"correct"/);
    expect((await stu.get(`/api/courses/${course.id}`)).body.completed).toEqual([quiz.pageId]);
    expect((await stu.get(A())).body[0]).toMatchObject({ attemptsUsed: 1, bestScore: 66.7, passed: true, inProgress: false });
  });
  it('a failing attempt does not complete the page', async () => {
    const m = await addQ(mcq); await setPass(60);
    const att = await attempt();
    const res = (await stu.post(`/api/courses/${course.id}/attempts/${att.id}/submit`).send({ answers: { [m.id]: { choices: [1] } } })).body;
    expect(res).toMatchObject({ status: 'graded', score: 0, passed: false });
    expect((await stu.get(`/api/courses/${course.id}`)).body.completed).toEqual([]);
  });
  it('resumes an open attempt, enforces the attempt limit, and refuses a second submit', async () => {
    const t = await addQ(tf);
    await inst.put(`${A()}/${quiz.id}`).send({ title: 'Quiz 1', maxAttempts: 1 });
    const a1 = await attempt(); expect((await attempt()).id).toBe(a1.id);
    const sub = () => stu.post(`/api/courses/${course.id}/attempts/${a1.id}/submit`).send({ answers: { [t.id]: { value: true } } });
    expect((await sub()).status).toBe(200); expect((await sub()).status).toBe(409);
    expect((await stu.post(`${A()}/${quiz.id}/attempts`)).status).toBe(403);
  });
  it('rejects bad responses and blank answers score zero', async () => {
    const m = await addQ(single); const t = await addQ(tf);
    const att = await attempt();
    const sub = (answers) => stu.post(`/api/courses/${course.id}/attempts/${att.id}/submit`).send({ answers });
    expect((await sub({ [m.id]: { choices: [9] } })).status).toBe(400);
    expect((await sub({ [t.id]: { value: 'true' } })).status).toBe(400);
    expect((await sub({})).body).toMatchObject({ status: 'graded', score: 0 });
  });
  it('only enrolled learners can take it, and nobody reads another learner\'s attempt', async () => {
    await addQ(tf);
    const out = login(app, { username: 'outsider1', roles: ['developer'] });
    expect((await out.post(`${A()}/${quiz.id}/attempts`)).status).toBe(404);
    expect((await inst.post(`${A()}/${quiz.id}/attempts`)).status).toBe(404); // authors are not learners unless enrolled
    const att = await attempt();
    expect((await out.get(`/api/courses/${course.id}/attempts/${att.id}`)).status).toBe(404);
    expect((await other.get(`/api/courses/${course.id}/attempts/${att.id}`)).status).toBe(404);
    expect((await inst.get(`/api/courses/${course.id}/attempts/${att.id}`)).status).toBe(200);
    expect((await inst.post(`/api/courses/${course.id}/attempts/${att.id}/submit`).send({ answers: {} })).status).toBe(403);
  });
  it('an empty assessment cannot be started', async () => {
    expect((await stu.post(`${A()}/${quiz.id}/attempts`)).status).toBe(409);
  });
});

describe('manual grading', () => {
  it('holds the attempt until the instructor grades the written answer, then finishes it', async () => {
    const t = await addQ(tf); const w = await addQ(text); // 1 + 4 points, pass at 60%
    const att = await attempt();
    const res = (await stu.post(`/api/courses/${course.id}/attempts/${att.id}/submit`).send({ answers: { [t.id]: { value: true }, [w.id]: { text: 'Scope is where names are visible.' } } })).body;
    expect(res).toMatchObject({ status: 'submitted', score: 20 }); expect(res.passed).toBeNull();
    expect((await stu.get(A())).body[0]).toMatchObject({ awaitingGrade: true, passed: false });
    const list = (await inst.get(`${A()}/${quiz.id}/attempts`)).body;
    expect(list).toMatchObject([{ id: att.id, status: 'submitted', learner: expect.any(String) }]);
    const seen = (await inst.get(`/api/courses/${course.id}/attempts/${att.id}`)).body;
    expect(seen.questions[1]).toMatchObject({ rubric: 'Mentions blocks', response: { text: 'Scope is where names are visible.' } });
    expect((await stu.put(`/api/courses/${course.id}/attempts/${att.id}/answers/${w.id}/grade`).send({ score: 4 })).status).toBe(403);
    expect((await inst.put(`/api/courses/${course.id}/attempts/${att.id}/answers/${w.id}/grade`).send({ score: 9 })).status).toBe(400);
    expect((await inst.put(`/api/courses/${course.id}/attempts/${att.id}/answers/${t.id}/grade`).send({ score: 1 })).status).toBe(400);
    const g = (await inst.put(`/api/courses/${course.id}/attempts/${att.id}/answers/${w.id}/grade`).send({ score: 3, feedback: 'Good, add an example' })).body;
    expect(g).toMatchObject({ status: 'graded', score: 80, passed: true });
    const mine = (await stu.get(`/api/courses/${course.id}/attempts/${att.id}`)).body;
    expect(mine.questions[1]).toMatchObject({ earned: 3, feedback: 'Good, add an example' }); expect(mine.questions[1].rubric).toBeUndefined();
    expect((await stu.get(`/api/courses/${course.id}`)).body.completed).toEqual([quiz.pageId]);
    // regrading lowers the score; with no pass score a graded attempt still counts as done
    expect((await inst.put(`/api/courses/${course.id}/attempts/${att.id}/answers/${w.id}/grade`).send({ score: 0 })).body).toMatchObject({ score: 20, passed: true });
  });
  it('cannot grade an attempt that is still open', async () => {
    const w = await addQ(text); const att = await attempt();
    expect((await inst.put(`/api/courses/${course.id}/attempts/${att.id}/answers/${w.id}/grade`).send({ score: 1 })).status).toBe(409);
  });
  it('deleting the assessment removes its attempts', async () => {
    await addQ(tf); await attempt();
    expect((await inst.del(`${A()}/${quiz.id}`)).status).toBe(200);
    expect(getDb().prepare('SELECT COUNT(*) n FROM attempts').get().n).toBe(0);
  });
});

describe('assessment modes', () => {
  const settings = (b) => inst.put(`${A()}/${quiz.id}`).send({ title: 'Quiz 1', ...b });
  const submit = (att, answers) => stu.post(`/api/courses/${course.id}/attempts/${att.id}/submit`).send({ answers });
  const done = async () => (await stu.get(`/api/courses/${course.id}`)).body.completed;

  it('defaults to unlimited with no pass score, and limited needs a count and takes no pass score', async () => {
    expect(quiz).toMatchObject({ mode: 'unlimited', passPct: null, maxAttempts: 0 });
    expect((await settings({ mode: 'limited', maxAttempts: 3 })).body).toMatchObject({ mode: 'limited', passPct: null, maxAttempts: 3 });
    expect((await settings({ mode: 'limited', maxAttempts: 0 })).status).toBe(400);
    expect((await settings({ mode: 'limited', maxAttempts: 3, passPct: 60 })).status).toBe(400);
    // an attempt count outside limited mode is ignored
    expect((await settings({ mode: 'unlimited', maxAttempts: 3, passPct: 60 })).body).toMatchObject({ mode: 'unlimited', passPct: 60, maxAttempts: 0 });
    expect((await settings({ maxAttempts: 2 })).body).toMatchObject({ mode: 'limited', maxAttempts: 2 }); // old clients: a count means limited
  });
  it('a pass score or unscored mode needs every question scored automatically, in both directions', async () => {
    await addQ(tf); const w = await addQ(text);
    expect((await settings({ passPct: 60 })).status).toBe(409);
    expect((await settings({ mode: 'unscored' })).status).toBe(409);
    expect((await settings({ mode: 'limited', maxAttempts: 2 })).status).toBe(200); // fine: the instructor grades it
    await inst.del(`${A()}/${quiz.id}/questions/${w.id}`);
    expect((await settings({ passPct: 60 })).status).toBe(200);
    const res = await inst.post(`${A()}/${quiz.id}/questions`).send(text);
    expect(res.status).toBe(409); expect(res.body.error).toBe('open_ended_questions');
    expect((await inst.post(`${A()}/${quiz.id}/questions`).send(mcq)).status).toBe(201);
  });
  it('limited attempts: the best score counts', async () => {
    const t = await addQ(tf); const m = await addQ(single); await settings({ mode: 'limited', maxAttempts: 2 });
    const a1 = await attempt(); await submit(a1, { [t.id]: { value: false } }); // wrong on the tf, blank mcq
    const a2 = await attempt(); await submit(a2, { [t.id]: { value: true }, [m.id]: { choices: [1] } });
    const info = (await stu.get(A())).body[0];
    expect(info).toMatchObject({ mode: 'limited', attemptsUsed: 2, passed: true });
    expect(info.bestScore).toBe(Math.max(...[a1, a2].map((x) => getDb().prepare('SELECT score FROM attempts WHERE id=?').get(x.id).score)));
    expect((await stu.post(`${A()}/${quiz.id}/attempts`)).status).toBe(403);
    expect(await done()).toEqual([quiz.pageId]);
  });
  it('a pass score holds back the page until it is met, with unlimited tries', async () => {
    const t = await addQ(tf); await settings({ passPct: 100 });
    const a1 = await attempt(); expect((await submit(a1, { [t.id]: { value: false } })).body).toMatchObject({ passed: false });
    expect(await done()).toEqual([]);
    const a2 = await attempt(); expect((await submit(a2, { [t.id]: { value: true } })).body).toMatchObject({ passed: true, score: 100 });
    expect(await done()).toEqual([quiz.pageId]);
  });
  it('unscored: no score is shown to anyone, but a pass score still gates the page', async () => {
    const t = await addQ(tf); await settings({ mode: 'unscored' });
    const a1 = await attempt();
    const res = (await submit(a1, { [t.id]: { value: false } })).body; // wrong
    expect(res).toMatchObject({ mode: 'unscored', status: 'graded', score: null }); expect(res.questions[0].earned).toBe(0);
    expect((await stu.get(A())).body[0]).toMatchObject({ mode: 'unscored', bestScore: null, attemptsUsed: 1 });
    expect((await inst.get(`${A()}/${quiz.id}/attempts`)).body[0].score).toBeNull();
    expect((await inst.get(`/api/courses/${course.id}/attempts/${a1.id}`)).body.score).toBeNull();
    expect(await done()).toEqual([quiz.pageId]); // no pass score: finishing it is enough
    getDb().prepare('DELETE FROM course_progress').run();
    await settings({ mode: 'unscored', passPct: 100 });
    await submit(await attempt(), { [t.id]: { value: false } });
    expect(await done()).toEqual([]);
    expect((await submit(await attempt(), { [t.id]: { value: true } })).body).toMatchObject({ passed: true, score: null });
    expect(await done()).toEqual([quiz.pageId]);
  });
});
