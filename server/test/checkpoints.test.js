import { sqlDb } from './db-sql.js';
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createCheckpoint, listCheckpoints, restoreCheckpoint, setTurnActive } from '../src/workspace/checkpoints.js';
import { freshDb, createApp, login, makeRole, tmpDir } from './helpers.js';

let root, data;
beforeEach(() => { root = tmpDir('cp-proj-'); data = tmpDir('cp-data-'); fs.writeFileSync(path.join(root, 'keep.txt'), 'v1'); fs.writeFileSync(path.join(root, 'gone.txt'), 'bye'); });
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// Git-heavy: each test runs several git commands, so allow more than the default 30 seconds on a loaded machine.
describe('checkpoints', { timeout: 120000 }, () => {
  it('creates and lists checkpoints newest-first with author', async () => {
    await createCheckpoint(1, root, { label: 'first', author: 'user', dataDir: data });
    await createCheckpoint(1, root, { label: 'second', author: 'agent', dataDir: data });
    const l = await listCheckpoints(1, root, data);
    expect(l.map((c) => [c.label, c.author])).toEqual([['second', 'agent'], ['first', 'user']]);
  });
  it('restore reverts modified, deleted, and added files and is itself undoable', async () => {
    const cp = await createCheckpoint(1, root, { label: 'base', dataDir: data });
    fs.writeFileSync(path.join(root, 'keep.txt'), 'v2');
    fs.unlinkSync(path.join(root, 'gone.txt'));
    fs.mkdirSync(path.join(root, 'sub')); fs.writeFileSync(path.join(root, 'sub/added.txt'), 'new');
    await restoreCheckpoint(1, root, cp.id, { dataDir: data });
    expect(read('keep.txt')).toBe('v1'); expect(read('gone.txt')).toBe('bye');
    expect(fs.existsSync(path.join(root, 'sub/added.txt'))).toBe(false);
    const labels = (await listCheckpoints(1, root, data)).map((c) => c.label);
    expect(labels[0]).toMatch(/^Restored to/); expect(labels[1]).toBe('Before restore');
    // roll forward: restoring the pre-restore checkpoint brings the edits back
    const pre = (await listCheckpoints(1, root, data))[1];
    await restoreCheckpoint(1, root, pre.id, { dataDir: data });
    expect(read('keep.txt')).toBe('v2'); expect(fs.existsSync(path.join(root, 'gone.txt'))).toBe(false);
  });
  it("never touches the user's own .git", async () => {
    fs.mkdirSync(path.join(root, '.git')); fs.writeFileSync(path.join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
    const before = fs.readdirSync(path.join(root, '.git')).sort();
    const cp = await createCheckpoint(1, root, { label: 'x', dataDir: data });
    fs.writeFileSync(path.join(root, 'keep.txt'), 'changed');
    await restoreCheckpoint(1, root, cp.id, { dataDir: data });
    expect(fs.readdirSync(path.join(root, '.git')).sort()).toEqual(before);
    expect(read('.git/HEAD')).toBe('ref: refs/heads/main\n');
  });
  it('ignores node_modules and refuses invalid ids / restore during a turn', async () => {
    fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules/x.js'), '1');
    const cp = await createCheckpoint(1, root, { label: 'x', dataDir: data });
    fs.writeFileSync(path.join(root, 'node_modules/x.js'), '2');
    await restoreCheckpoint(1, root, cp.id, { dataDir: data });
    expect(read('node_modules/x.js')).toBe('2');
    await expect(restoreCheckpoint(1, root, '--evil', { dataDir: data })).rejects.toThrow(/Invalid/);
    setTurnActive(1, true);
    await expect(restoreCheckpoint(1, root, cp.id, { dataDir: data })).rejects.toThrow(/agent is running/);
    setTurnActive(1, false);
  });
});

describe('checkpoint API', { timeout: 120000 }, () => {
  it('create/list/restore with RBAC, no step-up, and active-turn protection', async () => {
    await freshDb(); const app = createApp();
    await makeRole('viewer', ['project.read', 'project.write', 'files.read', 'files.write', 'checkpoint.read']);
    const dev = await login(app, { username: 'devuser' }), viewer = await login(app, { username: 'viewer1', roles: ['viewer'] });
    const p = (await dev.post('/api/projects').send({ name: 'demo' })).body;
    await dev.put(`/api/projects/${p.id}/file`).send({ path: 'a.txt', content: 'one' });
    const cp = (await dev.post(`/api/projects/${p.id}/checkpoints`).send({ label: 'init' })).body;
    expect(cp.id).toMatch(/^[0-9a-f]{40}$/);
    await dev.put(`/api/projects/${p.id}/file`).send({ path: 'a.txt', content: 'two' });
    expect((await dev.get(`/api/projects/${p.id}/checkpoints`)).body[0].label).toBe('init');
    expect((await dev.get(`/api/projects/${p.id}/checkpoints/${cp.id}/diff`)).body.files[0]).toMatchObject({ path: 'a.txt' });
    expect((await dev.post(`/api/projects/${p.id}/checkpoints/${cp.id}/restore`)).status).toBe(200);
    expect((await dev.get(`/api/projects/${p.id}/file?path=a.txt`)).body.content).toBe('one');
    // viewer cannot create or restore (and cannot even see another user's project)
    const vp = (await viewer.post('/api/projects').send({ name: 'vproj' })).body;
    expect((await viewer.post(`/api/projects/${vp.id}/checkpoints`).send({ label: 'x' })).status).toBe(403);
    expect((await viewer.post(`/api/projects/${vp.id}/checkpoints/${cp.id}/restore`)).status).toBe(403);
    // restore needs no step-up verification
    const stale = await login(app, { username: 'staleuser', stepup: false });
    const sp = (await stale.post('/api/projects').send({ name: 'sp' })).body;
    const scp = (await stale.post(`/api/projects/${sp.id}/checkpoints`).send({ label: 'a' })).body;
    const r = await stale.post(`/api/projects/${sp.id}/checkpoints/${scp.id}/restore`);
    expect(r.status).toBe(200);
    setTurnActive(p.id, true);
    expect((await dev.post(`/api/projects/${p.id}/checkpoints/${cp.id}/restore`)).status).toBe(409);
    setTurnActive(p.id, false);
  });
});

describe('checkpoint rollback of sessions', () => {
  it('hides later messages from the model, shows them grayed out, and brings them back on roll-forward', async () => {
    const { loadMessages, buildTimeline, recordCheckpointMarks, rollBackMessages, copyCheckpointMarks } = await import('../src/sessions.js');
    await freshDb();
    const db = sqlDb();
    const app = createApp(), dev = await login(app, { username: 'devuser' });
    const pid = (await dev.post('/api/projects').send({ name: 'demo' })).body.id, uid = (await db.prepare('SELECT id FROM users WHERE username=?').get('devuser')).id;
    const conv = (await db.prepare("INSERT INTO conversations (user_id, project_id, kind) VALUES (?,?,'agent')").run(uid, pid)).lastInsertRowid;
    const add = async (role, content) => (await db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)').run(conv, role, JSON.stringify({ role, content })));
    await add('user', 'one'); await add('assistant', 'reply one');
    await recordCheckpointMarks(pid, 'cp1');
    await add('user', 'two'); await add('assistant', 'reply two');
    await recordCheckpointMarks(pid, 'before');
    await rollBackMessages('cp1'); await copyCheckpointMarks('cp1', 'after');
    expect((await loadMessages(conv)).map((m) => m.content)).toEqual(['one', 'reply one']);
    const rows = (await db.prepare('SELECT role, content, archived, kind, rolled_back FROM messages ORDER BY id').all());
    expect(buildTimeline(rows).map((i) => [i.text, !!i.rolledBack])).toEqual([['one', false], ['reply one', false], ['two', true], ['reply two', true]]);
    await rollBackMessages('before');
    expect((await loadMessages(conv)).map((m) => m.content)).toEqual(['one', 'reply one', 'two', 'reply two']);
  });
});

describe('checkpoint events in the timeline', () => {
  it('keeps agent/system checkpoints after a reload, in order', async () => {
    const { buildTimeline } = await import('../src/sessions.js');
    const rows = [{ id: 1, role: 'user', content: JSON.stringify({ role: 'user', content: 'go' }) }, { id: 2, role: 'assistant', content: JSON.stringify({ role: 'assistant', content: 'done' }) }];
    const items = buildTimeline(rows, { events: [{ checkpoint_id: 'a', label: 'Start of turn', anchor_message_id: 1 }, { checkpoint_id: 'b', label: 'mid', anchor_message_id: 2 }] });
    expect(items.map((i) => i.kind)).toEqual(['user', 'checkpoint', 'assistant', 'checkpoint']);
  });
});
