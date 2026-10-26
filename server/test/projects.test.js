import { sqlDb } from './db-sql.js';
import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { simpleGit } from 'simple-git';
import { freshDb, createApp, login, request, tmpDir, makeRole } from './helpers.js';
import { saveSettings, getSettings } from '../src/settings.js';


let app, u;
const dirOf = async (id) => (await sqlDb().prepare('SELECT dir FROM projects WHERE id=?').get(id)).dir;
beforeEach(async () => { await freshDb(); app = createApp(); u = await login(app, { username: 'projuser' }); });
// Hand-built "stored" zip so hostile entry names (../, absolute) survive; AdmZip.addFile would sanitize them.
const zipB64 = (entries) => {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, content] of entries) {
    const n = Buffer.from(name), d = Buffer.from(content), crc = zlib.crc32(d);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, d); centrals.push(ch, n); offset += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]).toString('base64');
};

describe('projects & files', () => {
  it('creates a project, edits files, lists the tree, renames, and deletes inside the jail', async () => {
    const p = (await u.post('/api/projects').send({ name: 'web-app' })).body;
    expect((await u.put(`/api/projects/${p.id}/file`).send({ path: 'src/index.js', content: 'console.log(1)' })).status).toBe(200);
    expect((await u.get(`/api/projects/${p.id}/file?path=src/index.js`)).body.content).toBe('console.log(1)');
    expect((await u.get(`/api/projects/${p.id}/tree`)).body[0]).toMatchObject({ name: 'src', type: 'dir', children: [{ name: 'index.js', type: 'file' }] });
    expect((await u.post(`/api/projects/${p.id}/rename`).send({ from: 'src/index.js', to: 'src/main.js' })).status).toBe(200);
    expect((await u.del(`/api/projects/${p.id}/file?path=src/main.js`)).status).toBe(200);
    expect((await u.del(`/api/projects/${p.id}/file?path=.`)).status).toBe(400);
  });
  it('rejects traversal, absolute paths, symlink escapes, and bad names', async () => {
    const p = (await u.post('/api/projects').send({ name: 'jailed' })).body;
    for (const bad of ['../../etc/passwd', '/etc/passwd']) {
      expect((await u.get(`/api/projects/${p.id}/file?path=${encodeURIComponent(bad)}`)).status).toBe(400);
      expect((await u.put(`/api/projects/${p.id}/file`).send({ path: bad, content: 'x' })).status).toBe(400);
    }
    const out = tmpDir('outside-'); fs.writeFileSync(path.join(out, 's.txt'), 'secret');
    fs.symlinkSync(out, path.join(await dirOf(p.id), 'esc'));
    expect((await u.get(`/api/projects/${p.id}/file?path=esc/s.txt`)).status).toBe(400);
    expect((await u.post('/api/projects').send({ name: '../evil' })).status).toBe(400);
    expect((await u.post('/api/projects').send({ name: 'jailed' })).status).toBe(409);
  });
  it('imports a zip, and rejects zip-slip, absolute entries, and oversized archives', async () => {
    const ok = await u.post('/api/projects/import').send({ name: 'imp', zipBase64: zipB64([['a/b.txt', 'hello'], ['README.md', '# hi']]) });
    expect(ok.status).toBe(201);
    expect(fs.readFileSync(path.join(await dirOf(ok.body.id), 'a/b.txt'), 'utf8')).toBe('hello');
    const slip = await u.post('/api/projects/import').send({ name: 'slip', zipBase64: zipB64([['../../escape.txt', 'x']]) });
    expect(slip.status).toBe(400); expect(slip.body.error).toBe('zip_slip');
    expect(fs.existsSync(path.join(config().dataDir, 'escape.txt'))).toBe(false);
    expect((await u.post('/api/projects/import').send({ name: 'abs', zipBase64: zipB64([['/tmp/abs-evil.txt', 'x']]) })).status).toBe(400);
    expect(fs.existsSync('/tmp/abs-evil.txt')).toBe(false);
    expect((await sqlDb().prepare('SELECT COUNT(*) c FROM projects').get()).c).toBe(1); // failed imports leave nothing behind
    expect(fs.existsSync(path.join(config().dataDir, 'workspaces', String(u.id), 'slip'))).toBe(false);
  });
  it('accepts zip imports above 1 MB up to the admin-set max upload size', async () => {
    const big = zipB64([['big.bin', crypto.randomBytes(2 * 1024 * 1024).toString('hex').slice(0, 3 * 1024 * 1024)]]);
    expect(Buffer.from(big, 'base64').length).toBeGreaterThan(1024 * 1024);
    const ok = await u.post('/api/projects/import').send({ name: 'bigzip', zipBase64: big });
    expect(ok.status).toBe(201);
    await saveSettings('general', { ...getSettings('general'), maxUploadMb: 1 });
    const no = await u.post('/api/projects/import').send({ name: 'bigzip2', zipBase64: big });
    expect(no.status).toBe(413);
  });
  it('downloads the project as a zip (excluding node_modules)', async () => {
    const p = (await u.post('/api/projects').send({ name: 'dl' })).body;
    await u.put(`/api/projects/${p.id}/file`).send({ path: 'a.txt', content: 'AAA' });
    await u.put(`/api/projects/${p.id}/file`).send({ path: 'node_modules/x/i.js', content: 'no' });
    const res = await u.get(`/api/projects/${p.id}/download`).buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.headers['content-disposition']).toContain('dl.zip');
    const names = new AdmZip(res.body).getEntries().map((e) => e.entryName);
    expect(names).toContain('a.txt'); expect(names.some((n) => n.includes('node_modules'))).toBe(false);
  });
  it('download requires download.code', async () => {
    await makeRole('nodl', ['project.read', 'project.write']);
    const n = await login(app, { username: 'nodluser', roles: ['nodl'] });
    const p = (await n.post('/api/projects').send({ name: 'x1' })).body;
    expect((await n.get(`/api/projects/${p.id}/download`)).status).toBe(403);
  });
  it('commits to git (init on demand) and refuses to push to private addresses', async () => {
    const p = (await u.post('/api/projects').send({ name: 'gitproj' })).body;
    await u.put(`/api/projects/${p.id}/file`).send({ path: 'a.txt', content: '1' });
    expect((await u.get(`/api/projects/${p.id}/git/status`)).body.initialized).toBe(false);
    const c = await u.post(`/api/projects/${p.id}/git/commit`).send({ message: 'first' });
    expect(c.status).toBe(200);
    const log = await simpleGit(await dirOf(p.id)).log();
    expect(log.latest.message).toBe('first'); expect(log.latest.author_name).toBe('projuser');
    await u.put(`/api/projects/${p.id}/file`).send({ path: 'b.txt', content: '2' });
    expect((await u.get(`/api/projects/${p.id}/git/status`)).body.files[0].path).toBe('b.txt');
    expect((await u.post(`/api/projects/${p.id}/git/push`).send({ remoteUrl: 'https://127.0.0.1/repo.git' })).status).toBe(400);
    expect((await u.post(`/api/projects/${p.id}/git/push`).send({ remoteUrl: 'file:///tmp/repo' })).status).toBe(400);
  });
  it('clone refuses non-https and private URLs', async () => {
    expect((await u.post('/api/projects/import').send({ name: 'cl', gitUrl: 'http://example.com/r.git' })).status).toBe(400);
    expect((await u.post('/api/projects/import').send({ name: 'cl2', gitUrl: 'https://localhost/r.git' })).status).toBe(400);
  });
  it('deleting a project removes files and checkpoints', async () => {
    const p = (await u.post('/api/projects').send({ name: 'todel' })).body;
    const d = await dirOf(p.id);
    await u.post(`/api/projects/${p.id}/checkpoints`).send({ label: 'x' });
    expect((await u.del(`/api/projects/${p.id}`)).status).toBe(200);
    expect(fs.existsSync(d)).toBe(false);
  });
});
import { config as cfg } from '../src/config.js';
function config() { return cfg; }
