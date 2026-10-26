import { sqlDb } from './db-sql.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, login, addProvider, fakeAdapterFactory } from './helpers.js';

import { saveSettings, getSettings } from '../src/settings.js';
import { docText } from '../src/courses/tutor.js';
import { PRESETS } from '../src/courses/policy.js';

let script; let app; let inst; let stu; let admin; let seen; let course; let page;
const doc = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Closures' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'A closure captures variables.' }] }] };
const turn = (u, body, pid = page.id) => u.post(`/api/courses/${course.id}/pages/${pid}/turn`).send(body).buffer(true).parse((r, cb) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => cb(null, d)); });

beforeEach(async () => {
  await freshDb(); const mid = await addProvider();
  await saveSettings('general', { ...getSettings('general'), defaultModels: { plan: null, act: null, chat: mid } });
  seen = [];
  app = createApp({ deps: { adapterFactory: fakeAdapterFactory((script = [[{ type: 'text', text: 'Think about scope.' }], [{ type: 'text', text: 'Good.' }]]), seen) } });
  inst = await login(app, { username: 'teacher1', roles: ['instructor'] });
  stu = await login(app, { username: 'student1', roles: ['developer'] });
  admin = await login(app, { username: 'boss1', roles: ['administrator'] });
  course = (await inst.post('/api/courses').send({ title: 'JS Basics' })).body;
  await inst.put(`/api/courses/${course.id}`).send({ title: 'JS Basics', status: 'published' });
  page = (await inst.post(`/api/courses/${course.id}/pages`).send({ title: 'Scope', layout: 'agent', content: doc, config: { systemPrompt: 'Use Socratic questions.', subpanels: ['hints'], subpanelContent: { hints: { hints: ['Look at where x is declared'] } } } })).body;
  await inst.post(`/api/courses/${course.id}/enrollments`).send({ type: 'user', id: stu.id });
});

describe('course tutor panel', () => {
  it('extracts page text for the prompt', () => {
    expect(docText(doc)).toBe('Closures\nA closure captures variables.');
  });

  it('streams a reply, keeps history per page, and builds the prompt from the page without any tools', async () => {
    const res = await turn(stu, { message: 'What is a closure?' });
    expect(res.status).toBe(200); expect(res.body).toContain('Think about scope.');
    const s = seen.at(-1);
    expect(s.system).toContain('patient tutor'); expect(s.system).toContain('Use Socratic questions.'); expect(s.system).toContain('A closure captures variables.');
    expect(s.system).toContain('JS Basics'); expect(s.tools).toEqual([]);
    await turn(stu, { message: 'Another?' });
    expect(seen.at(-1).messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const hist = (await stu.get(`/api/courses/${course.id}/pages/${page.id}/conversation`)).body;
    expect(hist.messages.map((m) => m.content)).toEqual(['What is a closure?', 'Think about scope.', 'Another?', 'Good.']);
    expect((await sqlDb().prepare("SELECT kind FROM usage ORDER BY id DESC").get()).kind).toBe('course');
    // other users have their own history; the chat page's lists never include course conversations
    expect((await inst.get(`/api/courses/${course.id}/pages/${page.id}/conversation`)).body.messages).toEqual([]);
    expect((await stu.get('/api/conversations?kind=chat')).body).toEqual([]);
    expect((await stu.del(`/api/courses/${course.id}/pages/${page.id}/conversation`)).status).toBe(200);
    expect((await stu.get(`/api/courses/${course.id}/pages/${page.id}/conversation`)).body.messages).toEqual([]);
  });

  it('only enrolled learners (or the authors) can use the panel; content pages have none', async () => {
    const outsider = await login(app, { username: 'outsider1', roles: ['developer'] });
    expect((await turn(outsider, { message: 'hi' })).status).toBe(404);
    expect((await turn(inst, { message: 'preview try' })).status).toBe(200);
    const plain = (await inst.post(`/api/courses/${course.id}/pages`).send({ title: 'Plain' })).body;
    expect((await turn(stu, { message: 'hi' }, plain.id)).status).toBe(400);
    expect((await turn(stu, { message: '' })).status).toBe(400);
  });

  it('stops a runaway conversation', async () => {
    const mid = (await sqlDb().prepare('SELECT id FROM conversations').get());
    expect(mid).toBeUndefined();
    await turn(stu, { message: 'first' });
    const conv = (await sqlDb().prepare("SELECT id FROM conversations WHERE kind='course'").get()).id;
    const ins = sqlDb().prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)");
    for (let i = 0; i < 100; i++) ins.run(conv, 'user', JSON.stringify({ role: 'user', content: 'x' }));
    expect((await turn(stu, { message: 'more' })).status).toBe(429);
  });

  it('keeps learner notes private per page', async () => {
    expect((await stu.put(`/api/courses/${course.id}/pages/${page.id}/notes`).send({ text: 'remember scope' })).status).toBe(200);
    expect((await stu.get(`/api/courses/${course.id}/pages/${page.id}/notes`)).body.text).toBe('remember scope');
    expect((await inst.get(`/api/courses/${course.id}/pages/${page.id}/notes`)).body.text).toBe('');
  });

  it('subpanels come from the administrator catalog', async () => {
    const save = (config, layout = 'agent') => inst.put(`/api/courses/${course.id}/pages/${page.id}`).send({ title: 'Scope', layout, content: doc, config });
    expect((await save({ subpanels: ['bogus'] })).status).toBe(400);
    expect((await save({ subpanels: ['notes'] }, 'chat')).status).toBe(400);
    expect((await save({ subpanels: ['notes', 'hints'] })).status).toBe(200);
    expect((await save({ subpanelContent: { hints: { links: [{ title: 'x', url: 'javascript:alert(1)' }] } } })).status).toBe(400);
    // the catalog is admin-only, and disabling a subpanel stops new pages from using it
    expect((await inst.put('/api/admin/course-settings').send({ subpanels: [] })).status).toBe(403);
    const cat = (await admin.get('/api/admin/course-settings')).body;
    expect(cat.subpanels.map((x) => x.id)).toEqual(['notes', 'hints', 'resources', 'progress']);
    const next = cat.subpanels.map((x) => (x.id === 'notes' ? { ...x, enabled: false } : x));
    expect((await admin.put('/api/admin/course-settings').send({ subpanels: next })).status).toBe(200);
    expect((await save({ subpanels: ['notes'] })).status).toBe(400);
    expect((await stu.get(`/api/courses/${course.id}`)).body.subpanels.map((x) => x.id)).toEqual(['hints', 'resources', 'progress']);
    expect((await admin.put('/api/admin/course-settings').send({ subpanels: [{ id: 'A b', label: 'x', type: 'notes', enabled: true }] })).status).toBe(400);
  });

  it('uses the model chosen for the page, and only lets an instructor pick one they can use', async () => {
    const second = Number((await sqlDb().prepare("INSERT INTO models (provider_id, model_id, label) SELECT provider_id, 'other', 'Other' FROM models LIMIT 1").run()).lastInsertRowid);
    const body = (config) => ({ title: 'Scope', layout: 'agent', content: doc, config });
    expect((await inst.put(`/api/courses/${course.id}/pages/${page.id}`).send(body({ modelId: 99999 }))).status).toBe(400);
    expect((await inst.put(`/api/courses/${course.id}/pages/${page.id}`).send(body({ modelId: second }))).status).toBe(200);
    await turn(stu, { message: 'Which model?' });
    expect((await sqlDb().prepare('SELECT model_row_id m FROM usage ORDER BY id DESC').get()).m).toBe(second);
  });
  it('lets the administrator restrict which models an instructor can choose', async () => {
    const second = Number((await sqlDb().prepare("INSERT INTO models (provider_id, model_id, label) SELECT provider_id, 'other', 'Other' FROM models LIMIT 1").run()).lastInsertRowid);
    const first = (await sqlDb().prepare('SELECT id FROM models WHERE id<>?').get(second)).id;
    const save = (modelId) => inst.put(`/api/courses/${course.id}/pages/${page.id}`).send({ title: 'Scope', layout: 'agent', content: doc, config: { modelId } });
    expect((await inst.get('/api/courses-allowed-models')).body.allowed).toBe(null);
    expect((await save(second)).status).toBe(200);
    expect((await inst.put('/api/admin/course-settings').send({ allowedModelIds: [first] })).status).toBe(403);
    expect((await admin.put('/api/admin/course-settings').send({ allowedModelIds: [first] })).status).toBe(200);
    // saving other settings keeps the list, and it is exposed to instructors
    expect((await admin.put('/api/admin/course-settings').send({ subpanels: [] })).body.allowedModelIds).toEqual([first]);
    expect((await inst.get('/api/courses-allowed-models')).body.allowed).toEqual([first]);
    expect((await save(second)).body.error).toBe('model_not_allowed');
    expect((await save(first)).status).toBe(200);
    // a page that already uses a model that is no longer allowed falls back to the platform default for learners
    await save(first);
    (await sqlDb().prepare('UPDATE course_pages SET config_json=? WHERE id=?').run(JSON.stringify({ modelId: second }), page.id));
    await turn(stu, { message: 'Which model?' });
    expect((await sqlDb().prepare('SELECT model_row_id m FROM usage ORDER BY id DESC').get()).m).not.toBe(second);
    // exercises are held to the same list
    const a = (await inst.post(`/api/courses/${course.id}/assessments`).send({ title: 'Quiz' })).body;
    const ex = (modelId) => inst.post(`/api/courses/${course.id}/assessments/${a.id}/questions`).send({ type: 'exercise', prompt: 'Do it', spec: { brief: 'b', rubric: [{ label: 'ok', points: 1 }], policy: { ...PRESETS.guided, modelId } } });
    expect((await ex(second)).status).toBe(400);
    expect((await ex(first)).status).toBe(201);
    // null lifts the restriction
    expect((await admin.put('/api/admin/course-settings').send({ allowedModelIds: null })).status).toBe(200);
    expect((await save(second)).status).toBe(200);
  });
});

describe('tutor thinking', () => {
  const think = [{ type: 'thinking', text: 'Let me consider.' }, { type: 'text', text: 'Answer.' }];
  const setup = async (thinking) => {
    (await sqlDb().prepare("UPDATE models SET thinking_mode='adaptive'").run());
    const cfg = { ...JSON.parse((await sqlDb().prepare('SELECT config_json FROM course_pages WHERE id=?').get(page.id)).config_json), ...(thinking === undefined ? {} : { thinking }) };
    const r = await inst.put(`/api/courses/${course.id}/pages/${page.id}`).send({ title: 'Scope', layout: 'agent', content: doc, config: cfg });
    expect(r.status).toBe(200);
  };
  it('is off by default: no thinking setting is sent and streamed reasoning is dropped', async () => {
    await setup(); seen.length = 0;
    script.splice(0, script.length, think);
    const out = (await turn(stu, { message: 'hi' })).body;
    expect(seen[0].thinking).toEqual({ mode: 'off' });
    expect(out).not.toContain('"type":"thinking"');
    expect(out).toContain('Answer.');
  });
  it('when the instructor enables it, sends the model setting and streams the thinking before the answer', async () => {
    await setup(true); seen.length = 0;
    script.splice(0, script.length, think);
    const out = (await turn(stu, { message: 'hi' })).body;
    expect(seen[0].thinking.mode).toBe('adaptive');
    expect(out.indexOf('Let me consider.')).toBeGreaterThan(-1);
    expect(out.indexOf('Let me consider.')).toBeLessThan(out.indexOf('Answer.'));
  });
});
