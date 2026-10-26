import { sqlDb } from './db-sql.js';
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshDb, createApp, login } from './helpers.js';
import { openDb } from '../src/db/index.js';
import Database from 'better-sqlite3';
import { legacySchema } from '../src/db/legacy-migrate.js';

let app, inst, stu, course, P;
beforeEach(async () => {
  await freshDb(); app = createApp();
  inst = await login(app, { username: 'teacher1', roles: ['instructor'] });
  stu = await login(app, { username: 'student1', roles: ['developer'] });
  course = (await inst.post('/api/courses').send({ title: 'C' })).body;
  P = `/api/courses/${course.id}/pages`;
});
const order = async () => (await inst.get(`/api/courses/${course.id}`)).body.pages.map((p) => `${p.layout}:${p.title}`);

describe('assessments as pages', () => {
  it('a page of layout assessment creates the assessment, and sits among the other pages', async () => {
    await inst.post(P).send({ title: 'Intro' });
    const mod = (await inst.post(`/api/courses/${course.id}/modules`).send({ title: 'M' })).body;
    const q = (await inst.post(P).send({ title: 'Check', layout: 'assessment', moduleId: mod.id, content: { type: 'doc', content: [{ type: 'paragraph' }] } })).body;
    await inst.post(P).send({ title: 'Outro' });
    expect(q).toMatchObject({ layout: 'assessment', moduleId: mod.id, assessmentId: expect.any(Number) });
    expect(await order()).toEqual(['content:Intro', 'assessment:Check', 'content:Outro']);
    const manage = (await inst.get(`/api/courses/${course.id}/assessments/manage`)).body;
    expect(manage).toMatchObject([{ id: q.assessmentId, pageId: q.id, title: 'Check', mode: 'unlimited' }]);
  });
  it('POST /assessments makes the page too, and a title change goes both ways', async () => {
    const a = (await inst.post(`/api/courses/${course.id}/assessments`).send({ title: 'Quiz' })).body;
    const page = async () => (await sqlDb().prepare('SELECT * FROM course_pages WHERE id=?').get(a.pageId));
    expect(await page()).toMatchObject({ layout: 'assessment', title: 'Quiz' });
    await inst.put(`/api/courses/${course.id}/assessments/${a.id}`).send({ title: 'Renamed' });
    expect((await page()).title).toBe('Renamed');
    const p = (await inst.get(`/api/courses/${course.id}`)).body.pages[0];
    await inst.put(`${P}/${p.id}`).send({ title: 'Again', layout: 'assessment', content: p.content, config: {} });
    expect((await sqlDb().prepare('SELECT title FROM assessments WHERE id=?').get(a.id)).title).toBe('Again');
  });
  it('a page cannot turn into an assessment or back', async () => {
    const plain = (await inst.post(P).send({ title: 'Plain' })).body, quiz = (await inst.post(P).send({ title: 'Q', layout: 'assessment' })).body;
    expect((await inst.put(`${P}/${plain.id}`).send({ title: 'Plain', layout: 'assessment' })).body.error).toBe('layout_locked');
    expect((await inst.put(`${P}/${quiz.id}`).send({ title: 'Q', layout: 'content' })).body.error).toBe('layout_locked');
  });
  it('deleting the page deletes the assessment and its attempts', async () => {
    const quiz = (await inst.post(P).send({ title: 'Q', layout: 'assessment' })).body;
    expect((await inst.del(`${P}/${quiz.id}`)).status).toBe(200);
    expect((await sqlDb().prepare('SELECT COUNT(*) n FROM assessments').get()).n).toBe(0);
  });
  it('learners cannot mark an assessment page complete by hand', async () => {
    await inst.put(`/api/courses/${course.id}`).send({ title: 'C', status: 'published' });
    await inst.post(`/api/courses/${course.id}/enrollments`).send({ type: 'user', id: stu.id });
    const quiz = (await inst.post(P).send({ title: 'Q', layout: 'assessment' })).body;
    expect((await stu.post(`${P}/${quiz.id}/complete`)).body.error).toBe('completes_by_assessment');
    expect((await stu.get(`/api/courses/${course.id}`)).body.pages[0]).toMatchObject({ layout: 'assessment', assessmentId: quiz.assessmentId });
  });
});

describe('migrating old assessments to pages', () => {
  it('places each after the page it was attached to, or at the end, and keeps learner progress', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'db.sqlite');
    // A database from before assessments became pages: the legacy schema, with assessments that have no page of their own.
    const old = new Database(file);
    old.exec(legacySchema);
    const uid = Number(old.prepare("INSERT INTO users (username, source) VALUES ('s', 'local')").run().lastInsertRowid);
    const cid = Number(old.prepare("INSERT INTO courses (title, owner_id) VALUES ('C', ?)").run(uid).lastInsertRowid);
    const page = (t, pos) => Number(old.prepare('INSERT INTO course_pages (course_id, position, title) VALUES (?,?,?)').run(cid, pos, t).lastInsertRowid);
    const p1 = await page('One', 0), p2 = await page('Two', 1);
    const mk = (title, pageId) => Number(old.prepare('INSERT INTO assessments (course_id, page_id, title) VALUES (?,?,?)').run(cid, pageId, title).lastInsertRowid);
    const a1 = mk('After one', p1), a2 = mk('Also after one', p1), a3 = mk('Whole course', null);
    old.prepare("INSERT INTO attempts (assessment_id, user_id, status, score) VALUES (?,?, 'graded', 80)").run(a1, uid);
    old.close();

    const db = await openDb(file);
    const rows = await db.raw('SELECT title, layout FROM course_pages WHERE course_id=? ORDER BY position', [cid]);
    expect(rows.map((r) => r.title)).toEqual(['One', 'After one', 'Also after one', 'Two', 'Whole course']);
    expect(rows.filter((r) => r.layout === 'assessment')).toHaveLength(3);
    const pageOf = async (id) => (await db.raw('SELECT p.title FROM assessments a JOIN course_pages p ON p.id=a.page_id WHERE a.id=?', [id]))[0].title;
    expect(await Promise.all([a1, a2, a3].map(pageOf))).toEqual(['After one', 'Also after one', 'Whole course']);
    expect(await db.raw('SELECT p.title FROM course_progress c JOIN course_pages p ON p.id=c.page_id WHERE c.user_id=?', [uid])).toEqual([{ title: 'After one' }]);
    await db.destroy(); // reopening changes nothing
    const again = await openDb(file);
    expect((await again.raw('SELECT COUNT(*) n FROM course_pages'))[0].n).toBe(5);
    await again.destroy();
  });
});
