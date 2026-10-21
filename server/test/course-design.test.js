import { describe, it, expect } from 'vitest';
import { freshDb, createApp, login, makeRole, addProvider, fakeAdapterFactory } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { DEFAULT_COURSE_PROMPT } from '../src/agent/prompts.js';
import { markdownToDoc, docToMarkdown } from '../src/courses/design.js';

let modelId;
const setup = (script = [], seen = []) => { freshDb(); modelId = addProvider(); return createApp({ deps: { adapterFactory: fakeAdapterFactory(script, seen) } }); };
const chat = (u, body) => u.post('/api/chat/turn').send({ modelId, chatType: 'course', ...body }).buffer(true).parse((r, cb) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => cb(null, d)); });
const call = (id, name, args) => [{ type: 'tool_call', id, name, args }];
const say = [{ type: 'text', text: 'ok' }];
const mkCourse = async (u, title = 'Intro') => (await u.post('/api/courses').send({ title })).body.id;
const pages = (id) => getDb().prepare('SELECT * FROM course_pages WHERE course_id=? ORDER BY position').all(id);

describe('markdown <-> course page documents', () => {
  it('round-trips the supported blocks and marks', () => {
    const md = '# Title\n\nSome **bold**, *italic* and `code` with a [link](https://example.com).\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n> quoted\n\n```js\nlet a = 1;\n```\n\n---';
    expect(docToMarkdown(markdownToDoc(md))).toBe(md);
  });
  it('round-trips tables, including escaped pipes and ragged rows', () => {
    const md = 'Before\n\n| Name | Value |\n| --- | --- |\n| **a** | `x \\| y` |\n| b |  |\n\nAfter';
    const doc = markdownToDoc(md);
    expect(doc.content.map((n) => n.type)).toEqual(['paragraph', 'table', 'paragraph']);
    expect(doc.content[1].content[0].content[0].type).toBe('tableHeader');
    expect(docToMarkdown(doc)).toBe(md);
  });
  it('gives a header-less table an empty header row', () => {
    const doc = { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] }] }] };
    expect(docToMarkdown(doc)).toBe('|  |\n| --- |\n| a |');
  });
  it('never produces an empty text node or an unsafe link', () => {
    const doc = markdownToDoc('[x](javascript:alert(1)) and **\n\n');
    expect(JSON.stringify(doc)).not.toContain('"href"');
    expect(JSON.stringify(doc)).not.toContain('"text":""');
  });
});

describe('Course Design chat', () => {
  it('uses its own prompt, lists under its own tab, and offers the course tools', async () => {
    const seen = [], app = setup([say], seen), u = login(app, { username: 'inst1', roles: ['instructor'] });
    const cid = await mkCourse(u);
    const res = await chat(u, { message: 'hi', courseId: cid });
    expect(res.status).toBe(200);
    expect(seen.at(-1).system).toContain(DEFAULT_COURSE_PROMPT); expect(seen.at(-1).system).toContain('"Intro"');
    expect(seen.at(-1).tools).toEqual(expect.arrayContaining(['get_course', 'read_page', 'create_page', 'update_page']));
    const list = (await u.get('/api/conversations?kind=chat&chatType=course')).body;
    expect(list).toHaveLength(1); expect(list[0].courseId).toBe(cid);
    expect((await u.get('/api/conversations?kind=chat&chatType=coding')).body).toHaveLength(0);
    // the other tabs get no course tools
    makeRole('both', ['chat.general.use', 'provider.use']);
    await chat(login(app, { username: 'gen1', roles: ['both'] }), { chatType: 'general', message: 'x' });
    expect(seen.at(-1).tools).not.toContain('create_page');
  });

  it('needs the permission, course.author, and a course the user teaches', async () => {
    const app = setup([say, say, say, say]);
    const inst = login(app, { username: 'inst2', roles: ['instructor'] }), other = login(app, { username: 'inst3', roles: ['instructor'] });
    const cid = await mkCourse(inst);
    expect((await chat(inst, { message: 'x' })).status).toBe(400);                       // no course named
    expect((await chat(other, { message: 'x', courseId: cid })).status).toBe(404);       // someone else's course
    makeRole('nochat', ['course.author', 'provider.use']); makeRole('noauthor', ['chat.course.use', 'provider.use']);
    expect((await chat(login(app, { username: 'nc', roles: ['nochat'] }), { message: 'x', courseId: cid })).status).toBe(403);
    expect((await chat(login(app, { username: 'na', roles: ['noauthor'] }), { message: 'x', courseId: cid })).status).toBe(403);
    // a co-instructor can
    getDb().prepare('INSERT INTO course_instructors (course_id, user_id) VALUES (?,?)').run(cid, other.id);
    expect((await chat(other, { message: 'x', courseId: cid })).status).toBe(200);
  });

  it('a saved chat stays with its course, even if the client names another', async () => {
    const app = setup([say, say]), u = login(app, { username: 'inst4', roles: ['instructor'] });
    const a = await mkCourse(u, 'A'), b = await mkCourse(u, 'B');
    const res = await chat(u, { message: 'first', courseId: a });
    const convId = JSON.parse(res.body.split('\n\n').find((l) => l.startsWith('data: ')).slice(6)).conversationId;
    await chat(u, { message: 'again', courseId: b, conversationId: convId });
    expect(getDb().prepare('SELECT course_id FROM conversations WHERE id=?').get(convId).course_id).toBe(a);
  });

  it('reads and writes pages of a draft course', async () => {
    const script = [call('1', 'create_page', { title: 'Loops', markdown: '## Goals\n\n- use a loop' }), call('2', 'get_course', {}), say];
    const app = setup(script), u = login(app, { username: 'inst5', roles: ['instructor'] });
    const cid = await mkCourse(u);
    const res = await chat(u, { message: 'add a page', courseId: cid });
    expect(res.body).toContain('Created page');
    const [p] = pages(cid);
    expect(p.title).toBe('Loops'); expect(docToMarkdown(JSON.parse(p.content_json))).toBe('## Goals\n\n- use a loop');
    script.push(call('3', 'update_page', { page_id: p.id, markdown: '## Goals\n\n- use a loop\n- use a while' }), call('4', 'read_page', { page_id: p.id }), say);
    const res2 = await chat(u, { message: 'extend it', courseId: cid });
    expect(res2.body).toContain('Updated page'); expect(res2.body).toContain('use a while');
    expect(pages(cid)).toHaveLength(1);
    const act = getDb().prepare("SELECT action FROM audit WHERE action LIKE 'course.page.%'").all().map((r) => r.action);
    expect(act).toEqual(expect.arrayContaining(['course.page.create', 'course.page.update']));
  });

  it('refuses to change a published course, or a page of another course', async () => {
    const script = [call('1', 'create_page', { title: 'X', markdown: 'x' }), say, call('2', 'update_page', { page_id: 9999, markdown: 'x' }), say];
    const app = setup(script), u = login(app, { username: 'inst6', roles: ['instructor'] });
    const cid = await mkCourse(u);
    await u.put(`/api/courses/${cid}`).send({ title: 'Intro', status: 'published' });
    expect((await chat(u, { message: 'add', courseId: cid })).body).toContain('is published');
    expect(pages(cid)).toHaveLength(0);
    await u.put(`/api/courses/${cid}`).send({ title: 'Intro', status: 'draft' });
    expect((await chat(u, { message: 'edit', courseId: cid })).body).toContain('no such page');
  });

  it('loses access mid-chat when the instructor is removed', async () => {
    const script = [call('1', 'get_course', {}), say];
    const app = setup(script), owner = login(app, { username: 'inst7', roles: ['instructor'] }), co = login(app, { username: 'inst8', roles: ['instructor'] });
    const cid = await mkCourse(owner);
    getDb().prepare('INSERT INTO course_instructors (course_id, user_id) VALUES (?,?)').run(cid, co.id);
    const res = await chat(co, { message: 'x', courseId: cid });
    expect(res.body).toContain('Course: Intro');
  });

  it('the Course Design prompt can be overridden in the profile', async () => {
    const seen = [], app = setup([say], seen), u = login(app, { username: 'inst9', roles: ['instructor'] });
    expect((await u.get('/api/profile/prompts')).body.defaults.course).toBe(DEFAULT_COURSE_PROMPT);
    await u.put('/api/profile/prompts').send({ course: 'Be terse.' });
    await chat(u, { message: 'x', courseId: await mkCourse(u) });
    expect(seen.at(-1).system).toContain('Be terse.'); expect(seen.at(-1).system).not.toContain(DEFAULT_COURSE_PROMPT);
  });

  it('builds modules and puts pages in them, at the top level or inside', async () => {
    const script = [call('1', 'create_module', { title: 'Basics' }), say];
    const app = setup(script), u = login(app, { username: 'inst10', roles: ['instructor'] });
    const cid = await mkCourse(u);
    expect((await chat(u, { message: 'make a module', courseId: cid })).body).toContain('Created module');
    const mod = getDb().prepare('SELECT id FROM course_modules WHERE course_id=?').get(cid).id;
    script.push(call('2', 'create_page', { title: 'Inside', markdown: 'a', module_id: mod }), call('3', 'create_page', { title: 'Top', markdown: 'b' }), call('4', 'create_page', { title: 'Bad', markdown: 'c', module_id: 99999 }), say);
    const res = await chat(u, { message: 'add pages', courseId: cid });
    expect(res.body).toContain(`in module ${mod}`); expect(res.body).toContain('at the top level'); expect(res.body).toContain('no such module');
    const [inside, top] = pages(cid);
    expect([inside.module_id, top.module_id]).toEqual([mod, null]);
    script.push(call('5', 'update_page', { page_id: inside.id, module_id: 0 }), call('6', 'update_module', { module_id: mod, title: 'Renamed' }), call('7', 'get_course', {}), say);
    const out = (await chat(u, { message: 'rearrange', courseId: cid })).body;
    expect(out).toContain('Renamed module'); expect(out).toContain('[module');
    expect(pages(cid).map((p) => p.module_id)).toEqual([null, null]);
    expect(getDb().prepare('SELECT title FROM course_modules WHERE id=?').get(mod).title).toBe('Renamed');
  });
});

describe('Course Design chat: assessment questions', () => {
  const questions = (aid) => getDb().prepare('SELECT * FROM questions WHERE assessment_id=? ORDER BY position').all(aid);
  const mkAssessment = async (u, cid) => (await u.post(`/api/courses/${cid}/assessments`).send({ title: 'Quiz' })).body.id;

  it('creates, reads, updates and deletes questions', async () => {
    const script = [
      call('1', 'create_question', { assessment_id: 0, type: 'mcq', prompt: 'Which loops?', options: ['for', 'if'], correct: [0] }),
      call('2', 'create_question', { assessment_id: 0, type: 'tf', prompt: 'Lists are mutable', correct: true }), say];
    const app = setup(script), u = login(app, { username: 'inst7', roles: ['instructor'] });
    const cid = await mkCourse(u), aid = await mkAssessment(u, cid);
    script[0][0].args.assessment_id = aid; script[1][0].args.assessment_id = aid;
    expect((await chat(u, { message: 'add', courseId: cid })).body).toContain('Added mcq question');
    const [m, t] = questions(aid);
    expect(JSON.parse(m.answer_key_json)).toEqual({ correct: [0] }); expect(t.type).toBe('tf');
    script.push(call('3', 'update_question', { question_id: m.id, prompt: 'Which keyword loops?', options: ['for', 'if', 'while'], correct: [0, 2] }), call('4', 'delete_question', { question_id: t.id }), call('5', 'read_assessment', { assessment_id: aid }), say);
    const res = await chat(u, { message: 'edit', courseId: cid });
    expect(res.body).toContain('Updated question'); expect(res.body).toContain('Deleted question');
    expect(res.body).toContain('2. while (correct)');
    expect(questions(aid)).toHaveLength(1);
    const act = getDb().prepare("SELECT action FROM audit WHERE action LIKE 'course.question.%'").all().map((r) => r.action);
    expect(act).toEqual(expect.arrayContaining(['course.question.create', 'course.question.update', 'course.question.delete']));
  });

  it('rejects invalid questions, locked assessments, other courses, and published courses', async () => {
    const script = [call('1', 'create_question', { assessment_id: 0, type: 'mcq', prompt: 'Q', options: ['a', 'b'], correct: [5] }), say];
    const app = setup(script), u = login(app, { username: 'inst8', roles: ['instructor'] });
    const cid = await mkCourse(u), aid = await mkAssessment(u, cid), other = await mkCourse(u, 'Other'), oaid = await mkAssessment(u, other);
    script[0][0].args.assessment_id = aid;
    expect((await chat(u, { message: 'x', courseId: cid })).body).toContain('invalid question');
    script.push(call('2', 'create_question', { assessment_id: oaid, type: 'tf', prompt: 'Q', correct: true }), say);
    expect((await chat(u, { message: 'x', courseId: cid })).body).toContain('no such assessment');
    script.push(call('3', 'create_question', { assessment_id: aid, type: 'tf', prompt: 'Q', correct: true }), say);
    getDb().prepare('INSERT INTO attempts (assessment_id, user_id) VALUES (?,?)').run(aid, 1);
    expect((await chat(u, { message: 'x', courseId: cid })).body).toContain('locked');
    expect(questions(aid)).toHaveLength(0);
    await u.put(`/api/courses/${cid}`).send({ title: 'Intro', status: 'published' });
    script.push(call('4', 'create_question', { assessment_id: aid, type: 'tf', prompt: 'Q', correct: true }), say);
    expect((await chat(u, { message: 'x', courseId: cid })).body).toContain('is published');
  });

  it('creates, updates and deletes assessments, but not ones learners have attempted', async () => {
    const script = [call('1', 'create_assessment', { title: 'Midterm', pass_pct: 80 }), say];
    const app = setup(script), u = login(app, { username: 'inst9', roles: ['instructor'] });
    const cid = await mkCourse(u);
    await chat(u, { message: 'x', courseId: cid });
    const asm = () => getDb().prepare('SELECT * FROM assessments WHERE course_id=?').all(cid);
    expect(asm()).toHaveLength(1); expect(asm()[0]).toMatchObject({ title: 'Midterm', mode: 'unlimited', pass_score: 80, max_attempts: 0 });
    expect(pages(cid)).toMatchObject([{ title: 'Midterm', layout: 'assessment', id: asm()[0].page_id }]);
    const id = asm()[0].id;
    script.push(call('2', 'update_assessment', { assessment_id: id, max_attempts: 2 }), call('3', 'update_assessment', { assessment_id: id, pass_pct: 150 }), say);
    const res = await chat(u, { message: 'x', courseId: cid });
    expect(res.body).toContain('Updated assessment'); expect(res.body).toContain('invalid assessment');
    expect(asm()[0]).toMatchObject({ title: 'Midterm', mode: 'limited', pass_score: null, max_attempts: 2 });
    getDb().prepare('INSERT INTO attempts (assessment_id, user_id) VALUES (?,?)').run(id, 1);
    script.push(call('5', 'delete_assessment', { assessment_id: id }), say);
    expect((await chat(u, { message: 'x', courseId: cid })).body).toContain('cannot be deleted');
    getDb().prepare('DELETE FROM attempts').run();
    script.push(call('6', 'delete_assessment', { assessment_id: id }), say);
    expect((await chat(u, { message: 'x', courseId: cid })).body).toContain('Deleted assessment');
    expect(asm()).toHaveLength(0);
    expect(pages(cid)).toHaveLength(0); // the assessment's page went with it
  });
});
