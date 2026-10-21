import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { KernelManager } from '../src/terminal/kernel.js';
import { freshDb, createApp, login, makeRole, tmpDir } from './helpers.js';
import { saveSettings, getSettings } from '../src/settings.js';

const SHELL = () => saveSettings('general', { ...getSettings('general'), execMode: 'workspace_shell' });
let mgr;
beforeEach(() => { mgr = new KernelManager({ idleMs: 50 }); });
afterEach(() => mgr.killAll());
const cell = (k, code) => new Promise((resolve) => { const ev = []; k.run(code, (e) => { ev.push(e); }).then(() => resolve(ev)); });
const text = (ev, name) => ev.filter((e) => e.t === 'stream' && e.name === name).map((e) => e.text).join('');

describe('notebook kernel', () => {
  it('runs a cell, captures output, and shows the value of a last expression', async () => {
    const k = mgr.create(1, 1, 'a.ipynb', tmpDir('k-'));
    const ev = await cell(k, 'print("hi")\n1 + 2');
    expect(text(ev, 'stdout')).toBe('hi\n'); expect(ev.find((e) => e.t === 'result').data['text/plain']).toBe('3'); expect(ev.at(-1)).toMatchObject({ t: 'done', count: 1 });
  });
  it('keeps variables between cells and numbers executions', async () => {
    const k = mgr.create(1, 1, 'a.ipynb', tmpDir('k-'));
    await cell(k, 'x = 41'); const ev = await cell(k, 'x + 1');
    expect(ev.find((e) => e.t === 'result').data['text/plain']).toBe('42'); expect(ev.at(-1).count).toBe(2);
  });
  it('reports errors without the driver frames, and carries on afterwards', async () => {
    const k = mgr.create(1, 1, 'a.ipynb', tmpDir('k-'));
    const ev = await cell(k, '1/0'); const err = ev.find((e) => e.t === 'error');
    expect(err).toMatchObject({ ename: 'ZeroDivisionError' }); expect(err.traceback[0]).not.toMatch(/<string>/); expect(err.traceback[0]).toMatch(/<cell>/);
    expect((await cell(k, 'syntax error here')).find((e) => e.t === 'error').ename).toBe('SyntaxError');
    expect((await cell(k, '"still alive"')).find((e) => e.t === 'result').data['text/plain']).toBe("'still alive'");
  });
  it('captures stderr and output of child processes, and starts in the notebook folder', async () => {
    const dir = tmpDir('k-'); const k = mgr.create(1, 1, 'a.ipynb', dir);
    const ev = await cell(k, 'import sys, os\nprint("e", file=sys.stderr)\nos.system("echo child")\nprint(os.getcwd())');
    expect(text(ev, 'stderr')).toBe('e\n'); expect(text(ev, 'stdout')).toContain('child'); expect(text(ev, 'stdout')).toContain(path.basename(dir));
  });
  it('offers rich renderings of the last value and of display(), with a plain-text fallback', async () => {
    const k = mgr.create(1, 1, 'a.ipynb', tmpDir('k-'));
    const ev = await cell(k, 'class T:\n  def _repr_html_(self): return "<b>hi</b>"\n  def _repr_png_(self): return b"\\x89PNG"\n  def __repr__(self): return "T()"\ndisplay(T(), 5)\nT()');
    const d = ev.filter((e) => e.t === 'display'); expect(d).toHaveLength(2);
    expect(d[0].data).toMatchObject({ 'text/html': '<b>hi</b>', 'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), 'text/plain': 'T()' }); expect(d[1].data).toEqual({ 'text/plain': '5' });
    expect(ev.find((e) => e.t === 'result').data['text/html']).toBe('<b>hi</b>');
  });
  it('shows open matplotlib figures as images after the cell, then closes them', async () => {
    // a stand-in for matplotlib.pyplot: the real library is optional on the server
    const fake = 'import sys, types\nclass Fig:\n  def savefig(self, f, **k): f.write(b"PNGDATA")\nm = types.ModuleType("matplotlib.pyplot")\nm.open = []\nm.get_fignums = lambda: list(m.open)\nm.figure = lambda n: Fig()\nm.close = lambda a: m.open.clear()\nsys.modules["matplotlib.pyplot"] = m';
    const k = mgr.create(1, 1, 'a.ipynb', tmpDir('k-')); await cell(k, fake);
    const ev = await cell(k, 'm = sys.modules["matplotlib.pyplot"]; m.open[:] = [1, 2]');
    expect(ev.filter((e) => e.t === 'display').map((e) => e.data['image/png'])).toEqual([Buffer.from('PNGDATA').toString('base64'), Buffer.from('PNGDATA').toString('base64')]);
    expect(ev.at(-2).t).toBe('display'); expect((await cell(k, '1')).filter((e) => e.t === 'display')).toHaveLength(0);
  });
  it('does not leak the server environment', async () => {
    process.env.SUPER_SECRET_TOKEN = 'leak-me';
    const ev = await cell(mgr.create(1, 1, 'a.ipynb', tmpDir('k-')), 'import os\nos.environ.get("SUPER_SECRET_TOKEN")');
    expect(ev.find((e) => e.t === 'result')?.data).toBeUndefined();
  });
  it('interrupts a running cell and keeps the state', async () => {
    const k = mgr.create(1, 1, 'a.ipynb', tmpDir('k-')); await cell(k, 'y = 7');
    const p = cell(k, 'import time\nwhile True: time.sleep(0.05)'); await new Promise((r) => setTimeout(r, 400));
    expect(k.interrupt()).toBe(true); const ev = await p;
    expect(ev.find((e) => e.t === 'error').ename).toBe('KeyboardInterrupt'); expect((await cell(k, 'y')).find((e) => e.t === 'result').data['text/plain']).toBe('7');
  });
  it('kills a cell that ignores the interrupt; the next run needs a fresh kernel', async () => {
    const k = mgr.create(1, 1, 'a.ipynb', tmpDir('k-')); k.killAfterMs = 200;
    const p = cell(k, 'import signal\nsignal.signal(signal.SIGINT, lambda *a: None)\nwhile True: pass'); await new Promise((r) => setTimeout(r, 400));
    k.interrupt(); const ev = await p; expect(ev.find((e) => e.t === 'error').ename).toBe('KernelDied');
    expect(mgr.get(1, 1, 'a.ipynb')).toBeNull(); expect(mgr.create(1, 1, 'a.ipynb', tmpDir('k-'))).not.toBe(k);
  });
  it('limits kernels per user and sweeps idle ones', async () => {
    const m = new KernelManager({ maxPerUser: 1, idleMs: 0 }); const d = tmpDir('k-');
    m.create(1, 1, 'a.ipynb', d); expect(() => m.create(1, 1, 'b.ipynb', d)).toThrow('too_many_kernels');
    await new Promise((r) => setTimeout(r, 5)); m.sweep(); expect(m.get(1, 1, 'a.ipynb')).toBeNull(); m.killAll();
  });
});

describe('kernel REST API', () => {
  let app, shellUser, project;
  const sse = (req) => req.buffer(true).parse((res, cb) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => cb(null, d)); });
  const events = (r) => r.body.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
  beforeEach(async () => {
    freshDb(); app = createApp({ deps: { kernels: mgr } });
    makeRole('shellers', ['project.read', 'project.write', 'files.read', 'files.write', 'terminal.use']);
    shellUser = login(app, { username: 'shelluser', roles: ['shellers'] });
    project = (await shellUser.post('/api/projects').send({ name: 'nb1' })).body;
  });
  it('is off until shell mode is enabled', async () => {
    const r = await shellUser.post('/api/terminal/kernel/run').send({ projectId: project.id, path: 'a.ipynb', code: '1' });
    expect(r.status).toBe(403); expect(r.body.error).toBe('shell_disabled');
  });
  it('needs terminal.use and recent step-up, and rejects other file types and paths outside the project', async () => {
    SHELL();
    const dev = login(app, { username: 'devperson' }); const dp = (await dev.post('/api/projects').send({ name: 'dp' })).body;
    expect((await dev.post('/api/terminal/kernel/run').send({ projectId: dp.id, path: 'a.ipynb', code: '1' })).status).toBe(403);
    const stale = login(app, { username: 'stale1', roles: ['shellers'], stepup: false }); const sp = (await stale.post('/api/projects').send({ name: 'sp' })).body;
    expect((await stale.post('/api/terminal/kernel/run').send({ projectId: sp.id, path: 'a.ipynb', code: '1' })).body.error).toBe('mfa_required');
    expect((await shellUser.post('/api/terminal/kernel/run').send({ projectId: project.id, path: 'a.py', code: '1' })).status).toBe(400);
    expect((await shellUser.post('/api/terminal/kernel/run').send({ projectId: project.id, path: '../x.ipynb', code: '1' })).status).toBe(400);
    expect((await login(app, { username: 'other3', roles: ['shellers'] }).post('/api/terminal/kernel/run').send({ projectId: project.id, path: 'a.ipynb', code: '1' })).status).toBe(404);
  });
  it('streams a cell\'s events, keeps state in the same notebook, and restarts on request', async () => {
    SHELL();
    const run = (code) => sse(shellUser.post('/api/terminal/kernel/run').send({ projectId: project.id, path: 'a.ipynb', code }));
    const a = events(await run('z = 5\nprint("out")')); expect(a.filter((e) => e.t === 'stream').map((e) => e.text).join('')).toBe('out\n'); expect(a.at(-1).t).toBe('done');
    expect(events(await run('z * 2')).find((e) => e.t === 'result').data['text/plain']).toBe('10');
    expect((await shellUser.post('/api/terminal/kernel/restart').send({ projectId: project.id, path: 'a.ipynb' })).body.ok).toBe(true);
    expect(events(await run('z')).find((e) => e.t === 'error').ename).toBe('NameError');
    expect((await shellUser.post('/api/terminal/kernel/interrupt').send({ projectId: project.id, path: 'a.ipynb' })).body.interrupted).toBe(false);
  });
});
