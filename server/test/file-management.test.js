import { sqlDb } from './db-sql.js';
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { freshDb, createApp, login, makeRole } from './helpers.js';

import { setTurnActive } from '../src/workspace/checkpoints.js';
import { saveSettings, getSettings } from '../src/settings.js';

let app, u, p;
const dirOf = async () => (await sqlDb().prepare('SELECT dir FROM projects WHERE id=?').get(p.id)).dir;
const put = (rel, body, q = '') => u.put(`/api/projects/${p.id}/upload?path=${encodeURIComponent(rel)}${q}`).set('Content-Type', 'application/octet-stream').send(body);
const rename = (from, to, extra = {}) => u.post(`/api/projects/${p.id}/rename`).send({ from, to, ...extra });
const file = async (rel, text) => { const f = path.join(await dirOf(), rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const bin = (r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };
beforeEach(async () => { await freshDb(); app = createApp(); u = await login(app, { username: 'fileuser' }); p = (await u.post('/api/projects').send({ name: 'fm' })).body; });

describe('upload', () => {
  it('stores binary files byte for byte', async () => {
    const bytes = Buffer.from([0, 255, 1, 254, 0x89, 0x50, 0x4e, 0x47, 0, 0]);
    const r = await put('img/logo.png', bytes); expect(r.status).toBe(201); expect(r.body).toMatchObject({ path: 'img/logo.png', bytes: 10 });
    expect(fs.readFileSync(path.join(await dirOf(), 'img/logo.png'))).toEqual(bytes);
    expect((await sqlDb().prepare("SELECT COUNT(*) c FROM audit WHERE action='file.upload'").get()).c).toBe(1);
  });
  it('never replaces an existing file unless asked', async () => {
    await file('a.txt', 'old'); expect((await put('a.txt', 'new')).status).toBe(409);
    expect(fs.readFileSync(path.join(await dirOf(), 'a.txt'), 'utf8')).toBe('old');
    expect((await put('a.txt', 'new', '&overwrite=1')).status).toBe(201); expect(fs.readFileSync(path.join(await dirOf(), 'a.txt'), 'utf8')).toBe('new');
    fs.mkdirSync(path.join(await dirOf(), 'dir')); expect((await put('dir', 'x', '&overwrite=1')).status).toBe(409); // a folder is never replaced by a file
  });
  it('is confined to the project and respects the size limit', async () => {
    for (const bad of ['../escape.txt', '/etc/evil', '']) expect((await put(bad, 'x')).status, bad).toBe(400);
    expect(fs.existsSync(path.join(await dirOf(), '..', 'escape.txt'))).toBe(false);
    const out = fs.mkdtempSync(path.join(fs.realpathSync(await dirOf()), '..', 'o-')); fs.symlinkSync(out, path.join(await dirOf(), 'link'));
    expect((await put('link/x.txt', 'x')).status).toBe(400); expect(fs.readdirSync(out)).toEqual([]);
    await saveSettings('general', { ...getSettings('general'), maxUploadMb: 1 }); expect((await put('big.bin', Buffer.alloc(1.5 * 1024 * 1024))).status).toBe(413);
  });
  it('needs files.write, a CSRF token, and is blocked while the agent is running', async () => {
    await makeRole('reader', ['project.read', 'files.read', 'download.code']); const r = await login(app, { username: 'readeruser', roles: ['reader'] }); const rp = (await (await login(app, { username: 'x1y2z3', roles: ['developer'] })).post('/api/projects').send({ name: 'z' })).body;
    expect((await r.put(`/api/projects/${rp.id}/upload?path=a.txt`).set('Content-Type', 'application/octet-stream').send('x')).status).toBe(403);
    expect((await (await import('./helpers.js')).request(app).put(`/api/projects/${p.id}/upload?path=a.txt`).set('Cookie', u.cookie).set('Content-Type', 'application/octet-stream').send('x')).status).toBe(403); // no csrf header
    setTurnActive(p.id, true); expect((await put('a.txt', 'x')).status).toBe(409); setTurnActive(p.id, false);
  });
});

describe('rename and move', () => {
  it('renames files and folders (with their contents) and creates missing parents', async () => {
    await file('a.txt', 'A'); await file('src/x.js', 'X'); await file('src/sub/y.js', 'Y');
    expect((await rename('a.txt', 'docs/a-renamed.txt')).status).toBe(200); expect(fs.readFileSync(path.join(await dirOf(), 'docs/a-renamed.txt'), 'utf8')).toBe('A'); expect(fs.existsSync(path.join(await dirOf(), 'a.txt'))).toBe(false);
    expect((await rename('src', 'lib')).status).toBe(200); expect(fs.readFileSync(path.join(await dirOf(), 'lib/sub/y.js'), 'utf8')).toBe('Y');
  });
  it('refuses to overwrite by default; allows file-over-file replacement only when asked; never directories', async () => {
    await file('a.txt', 'A'); await file('b.txt', 'B'); fs.mkdirSync(path.join(await dirOf(), 'd1')); fs.mkdirSync(path.join(await dirOf(), 'd2'));
    const r = await rename('a.txt', 'b.txt'); expect(r.status).toBe(409); expect(r.body.error).toBe('exists'); expect(fs.readFileSync(path.join(await dirOf(), 'b.txt'), 'utf8')).toBe('B');
    expect((await rename('a.txt', 'b.txt', { overwrite: true })).status).toBe(200); expect(fs.readFileSync(path.join(await dirOf(), 'b.txt'), 'utf8')).toBe('A');
    expect((await rename('d1', 'd2', { overwrite: true })).body.error).toBe('exists_directory');
  });
  it('refuses to move a folder into itself or its own descendants, and the project root', async () => {
    await file('top/inner/f.txt', 'x');
    expect((await rename('top', 'top/inner/top')).body.error).toBe('cannot_move_into_itself'); expect((await rename('top', 'top/copy')).status).toBe(400);
    expect(fs.existsSync(path.join(await dirOf(), 'top/inner/f.txt'))).toBe(true);
    expect((await rename('.', 'elsewhere')).body.error).toBe('cannot_move_root');
    expect((await rename('topper', 'top-x')).status).toBe(404); // "top" is not a prefix match for "topper"
    await file('topper/f', 'x'); expect((await rename('top', 'topper-2')).status).toBe(200); // sibling with a shared name prefix is fine
  });
  it('same-path rename is a no-op, and moving out of the project is rejected', async () => {
    await file('a.txt', 'A'); expect((await rename('a.txt', 'a.txt')).body.unchanged).toBe(true);
    expect((await rename('a.txt', '../out.txt')).status).toBe(400); expect((await rename('../etc/passwd', 'x')).status).toBe(400);
  });
  it('is blocked while the agent runs', async () => { await file('a.txt', 'A'); setTurnActive(p.id, true); expect((await rename('a.txt', 'b.txt')).status).toBe(409); setTurnActive(p.id, false); });
});

describe('download', () => {
  it('downloads a single file as an opaque attachment (never rendered on our origin)', async () => {
    await file('page.html', '<script>alert(1)</script>');
    const r = await u.get(`/api/projects/${p.id}/download-file?path=page.html`).buffer(true).parse(bin);
    expect(r.headers['content-type']).toMatch(/application\/octet-stream/); expect(r.headers['content-disposition']).toMatch(/attachment; filename="?page\.html"?/); expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.body.toString()).toBe('<script>alert(1)</script>');
  });
  it('downloads binary content intact and rejects directories, traversal, and missing files', async () => {
    const bytes = Buffer.from([0, 1, 2, 255, 254]); fs.writeFileSync(path.join(await dirOf(), 'b.bin'), bytes);
    expect((await u.get(`/api/projects/${p.id}/download-file?path=b.bin`).buffer(true).parse(bin)).body).toEqual(bytes);
    fs.mkdirSync(path.join(await dirOf(), 'd')); expect((await u.get(`/api/projects/${p.id}/download-file?path=d`)).status).toBe(400);
    expect((await u.get(`/api/projects/${p.id}/download-file?path=../x`)).status).toBe(400); expect((await u.get(`/api/projects/${p.id}/download-file?path=nope`)).status).toBe(404);
  });
  it('zips a single folder (without node_modules), named after the folder', async () => {
    await file('src/a.js', 'A'); await file('src/deep/b.js', 'B'); await file('src/node_modules/x/i.js', 'N'); await file('other.txt', 'O');
    const r = await u.get(`/api/projects/${p.id}/download?path=src`).buffer(true).parse(bin);
    expect(r.headers['content-disposition']).toContain('src.zip');
    const names = new AdmZip(r.body).getEntries().map((e) => e.entryName).sort(); expect(names).toEqual(expect.arrayContaining(['a.js', 'deep/b.js'])); expect(names.some((n) => n.includes('node_modules') || n === 'other.txt')).toBe(false);
    expect((await u.get(`/api/projects/${p.id}/download?path=other.txt`)).status).toBe(400);
  });
  it('single-file download needs files.read; a folder zip additionally needs download.code; other users\' projects are invisible', async () => {
    await makeRole('nozip', ['project.read', 'project.write', 'files.read']);
    const n = await login(app, { username: 'nozipper', roles: ['nozip'] }); const np = (await n.post('/api/projects').send({ name: 'q' })).body;
    fs.writeFileSync(path.join((await sqlDb().prepare('SELECT dir FROM projects WHERE id=?').get(np.id)).dir, 'a.txt'), 'A');
    expect((await n.get(`/api/projects/${np.id}/download-file?path=a.txt`).buffer(true).parse(bin)).body.toString()).toBe('A');
    expect((await n.get(`/api/projects/${np.id}/download?path=.`)).status).toBe(403);
    await makeRole('blind', ['project.read', 'project.write']); const b = await login(app, { username: 'blinduser', roles: ['blind'] }); const bp = (await b.post('/api/projects').send({ name: 'w' })).body;
    expect((await b.get(`/api/projects/${bp.id}/download-file?path=a.txt`)).status).toBe(403);
    await file('a.txt', 'A'); const other = await login(app, { username: 'intruder1' }); expect((await other.get(`/api/projects/${p.id}/download-file?path=a.txt`)).status).toBe(404);
  });
});

describe('search', () => {
  const find = (q) => u.get(`/api/projects/${p.id}/search?${q}`);
  it('finds literal matches with line and column, skipping node_modules and binary files', async () => {
    await file('a.js', 'const Foo = 1;\nlet foo = 2; // foo\n'); await file('src/b.txt', 'nothing'); await file('node_modules/x.js', 'foo'); await file('img.bin', 'foo\0');
    const r = await find('q=foo'); expect(r.status).toBe(200);
    expect(r.body.results.map((x) => x.path)).toEqual(['a.js']);
    expect(r.body.results[0].hits.map((h) => [h.line, h.col])).toEqual([[1, 7], [2, 5], [2, 17]]);
    expect(r.body.matches).toBe(3);
  });
  it('supports case, whole word, regex, and include/exclude', async () => {
    await file('a.js', 'foo foobar Foo'); await file('b.md', 'foo');
    expect((await find('q=foo&case=1')).body.matches).toBe(3); // foo, foo(bar) and b.md; case-sensitive drops Foo
    expect((await find('q=foo&word=1&case=1')).body.matches).toBe(2);
    expect((await find('q=fo%2B&regex=1&include=*.md')).body.results.map((x) => x.path)).toEqual(['b.md']);
    expect((await find('q=foo&exclude=*.md')).body.results.map((x) => x.path)).toEqual(['a.js']);
  });
  it('rejects a bad regex and cannot be frozen by a catastrophic one', async () => {
    expect((await find('q=(&regex=1')).status).toBe(400);
    await file('c.txt', `${'a'.repeat(40)}!`);
    const r = await find('q=(a%2B)%2B%24&regex=1'); expect([200, 408]).toContain(r.status);
  }, 20000);
  it('only searches the caller\'s own project', async () => {
    const other = await login(app, { username: 'other' });
    expect((await other.get(`/api/projects/${p.id}/search?q=x`)).status).toBe(404);
  });
});
