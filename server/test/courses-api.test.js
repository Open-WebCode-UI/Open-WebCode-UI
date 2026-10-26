import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, login } from './helpers.js';

let app; let inst; let stu; let other; let admin;
const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] };

async function course(status) {
  const c = (await inst.post('/api/courses').send({ title: 'Intro' })).body;
  if (status) await inst.put(`/api/courses/${c.id}`).send({ title: 'Intro', status });
  return c;
}

describe('courses API', () => {
  beforeEach(async () => {
    await freshDb(); app = createApp();
    inst = await login(app, { username: 'teacher1', roles: ['instructor'] });
    other = await login(app, { username: 'teacher2', roles: ['instructor'] });
    stu = await login(app, { username: 'student1', roles: ['developer'] });
    admin = await login(app, { username: 'boss1', roles: ['administrator'] });
  });

  it('only instructors can create courses', async () => {
    expect((await stu.post('/api/courses').send({ title: 'x' })).status).toBe(403);
    expect((await inst.post('/api/courses').send({ title: '' })).status).toBe(400);
    const r = await inst.post('/api/courses').send({ title: 'Intro' });
    expect(r.status).toBe(201); expect(r.body.status).toBe('draft');
  });

  it('authors page CRUD and reorder; other instructors cannot touch the course', async () => {
    const c = await course();
    const a = (await inst.post(`/api/courses/${c.id}/pages`).send({ title: 'A', content: doc })).body;
    const b = (await inst.post(`/api/courses/${c.id}/pages`).send({ title: 'B', layout: 'chat', config: { systemPrompt: 'Be kind' } })).body;
    expect((await other.post(`/api/courses/${c.id}/pages`).send({ title: 'X' })).status).toBe(404);
    const item = (id) => ({ type: 'page', id });
    expect((await inst.put(`/api/courses/${c.id}/outline`).send({ items: [item(b.id), item(a.id)] })).status).toBe(200);
    expect((await inst.put(`/api/courses/${c.id}/outline`).send({ items: [item(a.id)] })).status).toBe(400);
    const full = (await inst.get(`/api/courses/${c.id}`)).body;
    expect(full.pages.map((p) => p.title)).toEqual(['B', 'A']);
    expect(full.canEdit).toBe(true);
    expect((await inst.post(`/api/courses/${c.id}/pages`).send({ title: 'Z', layout: 'bogus' })).status).toBe(400);
    expect((await inst.post(`/api/courses/${c.id}/pages`).send({ title: 'Z', config: { evil: 1 } })).status).toBe(400);
    expect((await inst.del(`/api/courses/${c.id}/pages/${a.id}`)).status).toBe(200);
    expect((await admin.get(`/api/courses/${c.id}`)).body.canEdit).toBe(true);
  });

  it('learners see only published, enrolled courses and never the tutor prompt', async () => {
    const c = await course();
    await inst.post(`/api/courses/${c.id}/pages`).send({ title: 'B', layout: 'agent', config: { systemPrompt: 'SECRET', subpanels: ['hints'] } });
    await inst.post(`/api/courses/${c.id}/enrollments`).send({ type: 'user', id: stu.id });
    expect((await stu.get(`/api/courses/${c.id}`)).status).toBe(404); // draft
    await inst.put(`/api/courses/${c.id}`).send({ title: 'Intro', status: 'published' });
    const got = (await stu.get(`/api/courses/${c.id}`)).body;
    expect(got.canEdit).toBe(false);
    expect(got.pages[0].config).toEqual({ subpanels: ['hints'] });
    expect((await stu.get('/api/courses')).body.map((x) => x.id)).toEqual([c.id]);
    expect((await other.get(`/api/courses/${c.id}`)).status).toBe(404);
  });

  it('tracks progress only for enrolled learners', async () => {
    const c = await course('published');
    const p = (await inst.post(`/api/courses/${c.id}/pages`).send({ title: 'A' })).body;
    expect((await stu.post(`/api/courses/${c.id}/pages/${p.id}/complete`)).status).toBe(404);
    await inst.post(`/api/courses/${c.id}/enrollments`).send({ type: 'role', id: 'developer' });
    expect((await stu.post(`/api/courses/${c.id}/pages/${p.id}/complete`)).status).toBe(200);
    const list = (await stu.get('/api/courses')).body[0];
    expect([list.pages, list.completed]).toEqual([1, 1]);
    expect((await stu.get(`/api/courses/${c.id}`)).body.completed).toEqual([p.id]);
  });

  it('SAML-group enrollment needs course.admin; unknown subjects are rejected', async () => {
    const c = await course();
    expect((await inst.post(`/api/courses/${c.id}/enrollments`).send({ type: 'saml_group', id: 'cs101' })).status).toBe(403);
    expect((await admin.post(`/api/courses/${c.id}/enrollments`).send({ type: 'saml_group', id: 'cs101' })).status).toBe(201);
    expect((await inst.post(`/api/courses/${c.id}/enrollments`).send({ type: 'role', id: 'nope' })).status).toBe(400);
    expect((await inst.post(`/api/courses/${c.id}/enrollments`).send({ type: 'user', id: 9999 })).status).toBe(400);
    const list = (await inst.get(`/api/courses/${c.id}/enrollments`)).body;
    expect(list).toEqual([{ type: 'saml_group', id: 'cs101', username: null, displayName: null }]);
    expect((await admin.del(`/api/courses/${c.id}/enrollments`).send({ type: 'saml_group', id: 'cs101' })).status).toBe(200);
  });

  it('lists authored courses per instructor and everything for admins', async () => {
    await course(); await other.post('/api/courses').send({ title: 'Theirs' });
    expect((await inst.get('/api/courses/authored')).body).toHaveLength(1);
    expect((await admin.get('/api/courses/authored')).body).toHaveLength(2);
    expect((await stu.get('/api/courses/authored')).status).toBe(403);
  });

  it('deleting a course cascades', async () => {
    const c = await course();
    await inst.post(`/api/courses/${c.id}/pages`).send({ title: 'A' });
    expect((await inst.del(`/api/courses/${c.id}`)).status).toBe(200);
    expect((await inst.get(`/api/courses/${c.id}`)).status).toBe(404);
  });

  it('admins designate and remove instructors without touching IdP-granted roles', async () => {
    expect((await inst.put(`/api/admin/instructors/${stu.id}`).send({ instructor: true })).status).toBe(403);
    expect((await stu.get('/api/courses/authored')).status).toBe(403);
    expect((await admin.put(`/api/admin/instructors/${stu.id}`).send({ instructor: true })).status).toBe(200);
    expect((await stu.get('/api/courses/authored')).status).toBe(200);
    const list = (await admin.get('/api/admin/instructors')).body;
    expect(list.map((i) => i.id)).toContain(stu.id);
    expect((await admin.put(`/api/admin/instructors/${stu.id}`).send({ instructor: false })).status).toBe(200);
    expect((await stu.get('/api/courses/authored')).status).toBe(403);
    expect((await admin.put('/api/admin/instructors/9999').send({ instructor: true })).status).toBe(404);
  });

  it('searches users by name for enrollment, requires two characters, and escapes wildcards', async () => {
    expect((await inst.get('/api/courses-users?q=s')).body).toEqual([]);
    const hit = (await inst.get('/api/courses-users?q=student')).body;
    expect(hit).toHaveLength(1); expect(hit[0]).toMatchObject({ id: stu.id, username: 'student1' });
    expect((await inst.get('/api/courses-users?q=%25%25')).body).toEqual([]);
    expect((await stu.get('/api/courses-users?q=student')).status).toBe(403);
  });

  it('course admins list every course with group assignments and known groups', async () => {
    const c = await course();
    await admin.post(`/api/courses/${c.id}/enrollments`).send({ type: 'saml_group', id: 'cs101' });
    const all = (await admin.get('/api/admin/courses')).body;
    expect(all).toMatchObject([{ id: c.id, groups: ['cs101'], owner: expect.any(String) }]);
    expect((await inst.get('/api/admin/courses')).status).toBe(403);
    expect(Array.isArray((await admin.get('/api/admin/course-groups')).body)).toBe(true);
  });
});

describe('modules', () => {
  const outline = async (u, id) => (await u.get(`/api/courses/${id}`)).body.outline;
  const setup = async () => {
    await freshDb(); const app = createApp(); const inst = await login(app, { username: 'modt', roles: ['instructor'] });
    const c = (await inst.post('/api/courses').send({ title: 'Mods' })).body;
    const page = async (title, extra = {}) => (await inst.post(`/api/courses/${c.id}/pages`).send({ title, ...extra })).body;
    return { app, inst, c, page };
  };

  it('pages live at the top level or inside a module, and the reading order follows the outline', async () => {
    const { inst, c, page } = await setup();
    const intro = await page('Intro');
    const m1 = (await inst.post(`/api/courses/${c.id}/modules`).send({ title: 'Basics' })).body;
    const loops = await page('Loops', { moduleId: m1.id }), vars = await page('Vars', { moduleId: m1.id });
    const m2 = (await inst.post(`/api/courses/${c.id}/modules`).send({ title: 'Advanced' })).body;
    const wrap = await page('Wrap-up');
    const full = (await inst.get(`/api/courses/${c.id}`)).body;
    expect(full.outline).toEqual([{ type: 'page', id: intro.id }, { type: 'module', id: m1.id, title: 'Basics', pages: [loops.id, vars.id] }, { type: 'module', id: m2.id, title: 'Advanced', pages: [] }, { type: 'page', id: wrap.id }]);
    expect(full.pages.map((p) => p.title)).toEqual(['Intro', 'Loops', 'Vars', 'Wrap-up']);
    expect(full.pages.map((p) => p.moduleId)).toEqual([null, m1.id, m1.id, null]);
  });

  it('the outline call reorders and moves pages, and refuses a stale or partial outline', async () => {
    const { inst, c, page } = await setup();
    const a = await page('A'), b = await page('B'); const m = (await inst.post(`/api/courses/${c.id}/modules`).send({ title: 'M' })).body;
    const put = (items) => inst.put(`/api/courses/${c.id}/outline`).send({ items });
    expect((await put([{ type: 'module', id: m.id, pages: [b.id, a.id] }])).status).toBe(200);
    expect(await outline(inst, c.id)).toEqual([{ type: 'module', id: m.id, title: 'M', pages: [b.id, a.id] }]);
    expect((await put([{ type: 'module', id: m.id, pages: [b.id] }])).status).toBe(400);                        // drops a page
    expect((await put([{ type: 'module', id: m.id, pages: [b.id, a.id, a.id] }])).status).toBe(400);           // duplicates one
    expect((await put([{ type: 'page', id: a.id }, { type: 'page', id: b.id }])).status).toBe(400);            // drops the module
    expect((await put([{ type: 'page', id: a.id }, { type: 'module', id: m.id, pages: [b.id] }])).status).toBe(200);
  });

  it('a page can be moved into a module and back from its editor call; modules are per course', async () => {
    const { app, inst, c, page } = await setup();
    const a = await page('A'); const m = (await inst.post(`/api/courses/${c.id}/modules`).send({ title: 'M' })).body;
    const body = (moduleId) => ({ title: 'A', layout: 'content', content: {}, config: {}, moduleId });
    expect((await inst.put(`/api/courses/${c.id}/pages/${a.id}`).send(body(m.id))).status).toBe(200);
    expect((await outline(inst, c.id))[0]).toMatchObject({ type: 'module', pages: [a.id] });
    expect((await inst.put(`/api/courses/${c.id}/pages/${a.id}`).send(body(null))).status).toBe(200);
    expect(await outline(inst, c.id)).toEqual([{ type: 'module', id: m.id, title: 'M', pages: [] }, { type: 'page', id: a.id }]);
    const other = (await inst.post('/api/courses').send({ title: 'Other' })).body;
    expect((await inst.put(`/api/courses/${c.id}/pages/${a.id}`).send(body(99999))).status).toBe(404);
    expect((await inst.post(`/api/courses/${other.id}/pages`).send({ title: 'X', moduleId: m.id })).status).toBe(404);
    expect((await (await login(app, { username: 'modt2', roles: ['instructor'] })).post(`/api/courses/${c.id}/modules`).send({ title: 'Z' })).status).toBe(404);
  });

  it('renames a module, and deleting one keeps its pages at the top level where it was', async () => {
    const { inst, c, page } = await setup();
    const first = await page('First'); const m = (await inst.post(`/api/courses/${c.id}/modules`).send({ title: 'M' })).body;
    const x = await page('X', { moduleId: m.id }), y = await page('Y', { moduleId: m.id }); const last = await page('Last');
    expect((await inst.put(`/api/courses/${c.id}/modules/${m.id}`).send({ title: 'Renamed' })).status).toBe(200);
    expect((await outline(inst, c.id))[1].title).toBe('Renamed');
    expect((await inst.del(`/api/courses/${c.id}/modules/${m.id}`)).status).toBe(200);
    expect(await outline(inst, c.id)).toEqual([first, x, y, last].map((p) => ({ type: 'page', id: p.id })));
    expect((await inst.del(`/api/courses/${c.id}/modules/${m.id}`)).status).toBe(404);
  });
});
