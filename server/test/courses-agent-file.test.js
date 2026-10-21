import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, login, addProvider, fakeAdapterFactory } from './helpers.js';
import { saveSettings, getSettings } from '../src/settings.js';

let app; let inst; let stu; let course; let page; let seen; let script;
const turn = (u, body, pid = page.id) => u.post(`/api/courses/${course.id}/pages/${pid}/turn`).send(body).buffer(true).parse((r, cb) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => cb(null, d)); });
const fileUrl = () => `/api/courses/${course.id}/pages/${page.id}/file`;

beforeEach(async () => {
  freshDb(); const mid = addProvider();
  saveSettings('general', { ...getSettings('general'), defaultModels: { plan: null, act: null, chat: mid } });
  seen = [];
  script = [[{ type: 'text', text: 'Done.' }]];
  app = createApp({ deps: { adapterFactory: fakeAdapterFactory(script, seen) } });
  inst = login(app, { username: 'teacher1', roles: ['instructor'] });
  stu = login(app, { username: 'student1', roles: ['developer'] });
  course = (await inst.post('/api/courses').send({ title: 'Python' })).body;
  await inst.put(`/api/courses/${course.id}`).send({ title: 'Python', status: 'published' });
  page = (await inst.post(`/api/courses/${course.id}/pages`).send({ title: 'Loops', layout: 'agent_file', config: { fileName: 'loops.py', fileContent: 'for i in range(3):\n    print(i)\n' } })).body;
  await inst.post(`/api/courses/${course.id}/enrollments`).send({ type: 'user', id: stu.id });
});

describe('content with agent and file layout', () => {
  it('saves the layout and rejects file names with folders', async () => {
    expect(page.layout).toBe('agent_file');
    expect(page.config.fileName).toBe('loops.py');
    const bad = await inst.put(`/api/courses/${course.id}/pages/${page.id}`).send({ title: 'Loops', layout: 'agent_file', content: {}, config: { fileName: '../x' } });
    expect(bad.status).toBe(400);
  });

  it('gives each learner their own copy, starting from the instructor text', async () => {
    expect((await stu.get(fileUrl())).body).toEqual({ name: 'loops.py', content: 'for i in range(3):\n    print(i)\n', modified: false });
    await stu.put(fileUrl()).send({ content: 'print("mine")' });
    expect((await stu.get(fileUrl())).body).toMatchObject({ content: 'print("mine")', modified: true });
    expect((await inst.get(fileUrl())).body.content).toContain('range(3)');
    expect((await stu.del(fileUrl())).body.content).toContain('range(3)');
  });

  it('has no file on other layouts', async () => {
    const plain = (await inst.post(`/api/courses/${course.id}/pages`).send({ title: 'Plain', layout: 'chat' })).body;
    expect((await stu.get(`/api/courses/${course.id}/pages/${plain.id}/file`)).status).toBe(400);
  });

  it('offers only the file tools, and sees the editor text the learner sent', async () => {
    const res = await turn(stu, { message: 'Add a comment', content: 'x = 1\n' });
    expect(res.status).toBe(200);
    const names = seen.at(-1).tools;
    expect(names).toEqual(expect.arrayContaining(['read_file', 'edit_file', 'write_file']));
    for (const n of ['delete_file', 'run_command', 'create_checkpoint', 'spawn_agent', 'web_search', 'switch_mode']) expect(names).not.toContain(n);
    expect(seen.at(-1).system).toContain('loops.py');
    expect((await stu.get(fileUrl())).body.content).toBe('x = 1\n');
  });

  it('lets the agent edit the file, saves the result, and refuses any other path', async () => {
    script.length = 0;
    script.push(
      [{ type: 'tool_call', id: 't1', name: 'write_file', args: { path: 'loops.py', content: '# edited\n' } }, { type: 'tool_call', id: 't2', name: 'write_file', args: { path: 'other.py', content: 'no' } }],
      [{ type: 'text', text: 'Edited.' }],
    );
    const res = await turn(stu, { message: 'Rewrite it', content: 'x' });
    expect(res.body).toContain('"type":"file"');
    expect(res.body).toContain('you can only work on');
    expect((await stu.get(fileUrl())).body.content).toBe('# edited\n');
  });
});
