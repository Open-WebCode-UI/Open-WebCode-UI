import { sqlDb } from './db-sql.js';
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import { freshDb, createApp, login, tmpDir } from './helpers.js';

import { getSettings } from '../src/settings.js';
import { resolveForWrite, isGitPath, JailError } from '../src/workspace/jail.js';
import { safeGit } from '../src/workspace/git.js';
import { executeTool } from '../src/agent/tools.js';
import { extractZipSafely } from '../src/routes/projects.js';

let app, u;
const dirOf = async (id) => (await sqlDb().prepare('SELECT dir FROM projects WHERE id=?').get(id)).dir;
beforeEach(async () => { await freshDb(); app = createApp(); u = await login(app, { username: 'hardener' }); });

describe('.git is not writable through file APIs', () => {
  it('isGitPath matches any segment, case-insensitively', () => {
    for (const p of ['.git/config', 'a/.git/hooks/pre-commit', '.GIT/config', '.Git', 'x/.git ', 'GIT~1/config', 'a\\.git\\config']) expect(isGitPath(p), p).toBe(true);
    for (const p of ['.github/x.yml', 'src/gitignore.js', '.gitignore', 'a/.gitmodules', 'digit/x']) expect(isGitPath(p), p).toBe(false);
  });
  it('resolveForWrite refuses .git but allows normal paths', () => {
    const root = tmpDir('w-');
    expect(() => resolveForWrite(root, '.git/config')).toThrow(JailError);
    expect(() => resolveForWrite(root, 'sub/.GIT/hooks/x')).toThrow(JailError);
    expect(resolveForWrite(root, 'src/a.js')).toContain('src/a.js');
  });
  it('write, mkdir, rename, upload, and delete are all refused under .git; reads are still allowed', async () => {
    const p = (await u.post('/api/projects').send({ name: 'g1' })).body, id = p.id;
    fs.mkdirSync(path.join(await dirOf(id), '.git')); fs.writeFileSync(path.join(await dirOf(id), '.git/config'), '[core]\n');
    await u.put(`/api/projects/${id}/file`).send({ path: 'a.txt', content: 'x' });
    expect((await u.put(`/api/projects/${id}/file`).send({ path: '.git/config', content: '[core]\nfsmonitor = touch x' })).status).toBe(400);
    expect((await u.put(`/api/projects/${id}/file`).send({ path: '.GIT/config', content: 'x' })).status).toBe(400);
    expect((await u.post(`/api/projects/${id}/mkdir`).send({ path: '.git/hooks' })).status).toBe(400);
    expect((await u.post(`/api/projects/${id}/rename`).send({ from: 'a.txt', to: '.git/a.txt' })).status).toBe(400);
    expect((await u.post(`/api/projects/${id}/rename`).send({ from: '.git/config', to: 'c.txt' })).status).toBe(400);
    expect((await u.put(`/api/projects/${id}/upload?path=.git/config&overwrite=1`).set('content-type', 'application/octet-stream').send(Buffer.from('x'))).status).toBe(400);
    expect((await u.del(`/api/projects/${id}/file?path=.git/config`)).status).toBe(400);
    expect(fs.readFileSync(path.join(await dirOf(id), '.git/config'), 'utf8')).toBe('[core]\n');
    expect((await u.get(`/api/projects/${id}/file?path=.git/config`)).status).toBe(200);
  });
  it('the agent file tools cannot modify .git', async () => {
    const root = tmpDir('agent-');
    fs.mkdirSync(path.join(root, '.git')); fs.writeFileSync(path.join(root, '.git/config'), '[core]\n');
    const ctx = { root, projectId: 1, execMode: 'files_only', agentMode: 'act', permissions: new Set(['agent.act']), secretGlobs: [], dataDir: tmpDir('d-') };
    expect(await executeTool('write_file', { path: '.git/config', content: 'x' }, ctx)).toMatch(/^Error:.*\.git/);
    expect(await executeTool('edit_file', { path: '.git/config', old_string: 'core', new_string: 'x' }, ctx)).toMatch(/^Error:/);
    expect(await executeTool('delete_file', { path: '.git/config' }, ctx)).toMatch(/^Error:/);
    expect(fs.readFileSync(path.join(root, '.git/config'), 'utf8')).toBe('[core]\n');
  });
  it('zip import drops .git entries and keeps the rest', () => {
    const z = new AdmZip(); z.addFile('keep/a.txt', Buffer.from('a')); z.addFile('.git/config', Buffer.from('[core]')); z.addFile('sub/.git/hooks/pre-commit', Buffer.from('x'));
    const dest = tmpDir('z-'); extractZipSafely(z.toBuffer(), dest);
    expect(fs.existsSync(path.join(dest, 'keep/a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dest, '.git'))).toBe(false); expect(fs.existsSync(path.join(dest, 'sub/.git'))).toBe(false);
  });
});

describe('server-side git ignores a poisoned repository config', () => {
  it('core.fsmonitor in .git/config does not execute', async () => {
    const dir = tmpDir('poison-'), marker = path.join(tmpDir('m-'), 'PWNED');
    execFileSync('git', ['init', '-q', dir]);
    fs.appendFileSync(path.join(dir, '.git/config'), `[core]\n\tfsmonitor = touch ${marker}; echo\n`);
    execFileSync('git', ['-C', dir, 'status'], { stdio: 'ignore' }); // sanity: plain git does run it
    expect(fs.existsSync(marker)).toBe(true); fs.rmSync(marker);
    await safeGit(dir).status();
    expect(fs.existsSync(marker)).toBe(false);
  });
  it('does not leak server secrets into git', async () => {
    process.env.SECRET_FOR_TEST = 'topsecret';
    const dir = tmpDir('env-'); execFileSync('git', ['init', '-q', dir]);
    const out = await safeGit(dir).raw(['config', '--show-origin', '--list']);
    expect(out).not.toContain('topsecret');
    delete process.env.SECRET_FOR_TEST;
  });
});

describe('general settings: execution-affecting changes need step-up', () => {
  let admin;
  beforeEach(async () => { admin = await login(app, { username: 'setadmin', roles: ['administrator'] }); });
  const stale = async () => (await sqlDb().prepare('UPDATE sessions SET stepup_at=0').run());
  it('cannot change execMode through the generic route, even with fresh step-up', async () => {
    const r = await admin.put('/api/admin/general').send({ execMode: 'workspace_shell' });
    expect(r.status).toBe(400); expect(r.body.error).toBe('use_exec_mode_endpoint');
    expect(getSettings('general').execMode).toBe('files_only');
  });
  it('shell limits and secret globs need step-up only when they change', async () => {
    await stale();
    const before = getSettings('general');
    expect((await admin.put('/api/admin/general').send({ ...before, appName: 'Renamed' })).status).toBe(200); // unchanged risky fields re-sent
    const r = await admin.put('/api/admin/general').send({ secretGlobs: [] });
    expect(r.status).toBe(403); expect(r.body).toMatchObject({ error: 'mfa_required', stepup: true });
    expect((await admin.put('/api/admin/general').send({ shellTimeoutSec: 600 })).status).toBe(403);
    expect(getSettings('general').secretGlobs).toEqual(before.secretGlobs);
    (await sqlDb().prepare('UPDATE sessions SET stepup_at=?').run(Math.floor(Date.now() / 1000)));
    expect((await admin.put('/api/admin/general').send({ secretGlobs: ['.env'] })).status).toBe(200);
  });
});

describe('agent search', () => {
  const ctxFor = (root, extra = {}) => ({ root, projectId: 1, execMode: 'files_only', agentMode: 'plan', permissions: new Set(), secretGlobs: ['.env'], dataDir: tmpDir('d-'), ...extra });
  it('a catastrophic regex times out instead of freezing the server', async () => {
    const root = tmpDir('s-'); fs.writeFileSync(path.join(root, 'a.txt'), `${'a'.repeat(60)}!\n`);
    const t0 = Date.now(), tick = setInterval(() => {}, 5);
    const out = await executeTool('search', { pattern: '^(a+)+$' }, ctxFor(root, { searchTimeoutMs: 700 }));
    clearInterval(tick);
    expect(out).toMatch(/timed out/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
  it('the event loop stays responsive while a search is running', async () => {
    const root = tmpDir('s2-'); fs.writeFileSync(path.join(root, 'a.txt'), `${'a'.repeat(60)}!\n`);
    let ticks = 0; const iv = setInterval(() => { ticks++; }, 20);
    await executeTool('search', { pattern: '^(a+)+$' }, ctxFor(root, { searchTimeoutMs: 600 }));
    clearInterval(iv);
    expect(ticks).toBeGreaterThan(10);
  });
  it('still returns matches, skips secrets, rejects bad and oversized patterns, limits depth', async () => {
    const root = tmpDir('s3-'); fs.writeFileSync(path.join(root, 'a.txt'), 'hello world\n'); fs.writeFileSync(path.join(root, '.env'), 'hello secret\n');
    const deep = path.join(root, ...Array(25).fill('d')); fs.mkdirSync(deep, { recursive: true }); fs.writeFileSync(path.join(deep, 'x.txt'), 'hello deep\n');
    expect(await executeTool('search', { pattern: 'hello' }, ctxFor(root))).toBe('a.txt:1: hello world');
    expect((await executeTool('search', { pattern: '(' }, ctxFor(root)))).toMatch(/invalid regular expression/);
    expect(await executeTool('search', { pattern: 'a'.repeat(1001) }, ctxFor(root))).toMatch(/too long/);
    expect(await executeTool('search', { pattern: 'x', path: 'nope' }, ctxFor(root))).toMatch(/^Error:/);
  });
});

describe('zip extraction validates before inflating', () => {
  it('rejects an oversized entry or total without writing anything', () => {
    const z = new AdmZip(); z.addFile('small.txt', Buffer.from('ok')); z.addFile('big.bin', Buffer.alloc(5000, 1));
    const buf = z.toBuffer();
    for (const opts of [{ maxEntryBytes: 1000 }, { maxBytes: 3000 }]) {
      const dest = tmpDir('zb-');
      expect(() => extractZipSafely(buf, dest, opts)).toThrow(expect.objectContaining({ message: 'zip_too_large' }));
      expect(fs.readdirSync(dest)).toEqual([]); // small.txt precedes big.bin but was not extracted
    }
  });
  it('extracts a normal archive within limits', () => {
    const z = new AdmZip(); z.addFile('a/b.txt', Buffer.from('hello'));
    const dest = tmpDir('zok-'); extractZipSafely(z.toBuffer(), dest, { maxBytes: 1000, maxEntryBytes: 1000 });
    expect(fs.readFileSync(path.join(dest, 'a/b.txt'), 'utf8')).toBe('hello');
  });
});
