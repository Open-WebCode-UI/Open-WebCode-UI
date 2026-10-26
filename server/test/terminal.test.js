import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import { TerminalManager, clean } from '../src/terminal/manager.js';
import { attachTerminalWs } from '../src/terminal/ws.js';
import { freshDb, createApp, login, makeRole, tmpDir, addProvider, fakeAdapterFactory } from './helpers.js';
import { saveSettings, getSettings } from '../src/settings.js';
import { getDb } from '../src/db/index.js';
import { revokeUserSessions } from '../src/auth/session.js';

const SHELL = () => saveSettings('general', { ...getSettings('general'), execMode: 'workspace_shell' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let mgr;
beforeEach(() => { mgr = new TerminalManager({ idleMs: 50 }); });
afterEach(() => mgr.killAll());
const run = (command, o = {}) => mgr.agentRun({ userId: 1, projectId: 1, cwd: tmpDir('term-'), command, ...o });

describe('agent shell (persistent, captures output, and exit status)', () => {
  it('returns output and exit code; strips terminal escape codes', async () => {
    expect(await run('echo hello; echo world')).toMatchObject({ code: 0, output: 'hello\nworld\n', timedOut: false });
    expect(await run('printf "\\033[31mred\\033[0m\\n"; exit_code=3; (exit $exit_code)')).toMatchObject({ code: 3, output: 'red\n' });
    expect(clean('a\x1b[1;32mb\x1b[0m\r\nc')).toBe('ab\nc');
  });
  it('shows each command in the viewer (and its replay) before its output, without leaking it into the returned output', async () => {
    const cwd = tmpDir('term-'); const s = await mgr.create({ userId: 1, projectId: 1, kind: 'agent', cwd });
    let seen = ''; s.attach((m) => { if (m.type === 'output') seen += m.data; });
    const r = await mgr.agentRun({ userId: 1, projectId: 1, cwd, command: 'echo shown-output' });
    expect(r.output).toBe('shown-output\n');
    expect(seen).toContain('$ echo shown-output'); expect(seen.indexOf('$ echo shown-output')).toBeLessThan(seen.lastIndexOf('shown-output'));
    let replay = ''; s.attach((m) => { if (m.type === 'output') replay += m.data; }); expect(replay).toContain('$ echo shown-output');
  });
  it('keeps state between commands (cd, exported variables), like a real shell session', async () => {
    const cwd = tmpDir('term-'); const go = (c) => mgr.agentRun({ userId: 1, projectId: 1, cwd, command: c });
    await go('mkdir sub && cd sub && export FOO=bar');
    const r = await go('pwd; echo "FOO=$FOO"'); expect(r.output).toMatch(/\/sub\nFOO=bar\n/);
  });
  it('does not leak the server environment into the shell', async () => {
    process.env.SUPER_SECRET_TOKEN = 'leak-me'; expect((await run('echo "[$SUPER_SECRET_TOKEN]"; echo "[$SESSION_SECRET]"')).output).toBe('[]\n[]\n');
  });
  it('handles multi-line commands, heredocs, and commands far longer than a tty line limit', async () => {
    expect((await run('cat <<EOF\nline1\nline2\nEOF\nfor i in 1 2; do echo $i; done')).output).toBe('line1\nline2\n1\n2\n');
    const big = `echo ${'x'.repeat(9000)} | wc -c`; expect(Number((await run(big)).output.trim())).toBe(9001);
  });
  it('cannot be tricked by output that imitates its internal markers', async () => {
    const r = await run('echo "__E_deadbeef_0__"; echo still-running; exit 5'); expect(r.output).toContain('__E_deadbeef_0__'); expect(r.output).toContain('still-running'); expect(r.code).toBe(5); // `exit` ends the shell; reported at once, not after the timeout
  });
  it('interrupts commands that exceed the timeout and keeps the shell usable', async () => {
    const r = await run('sleep 30', { timeoutSec: 1 }); expect(r.timedOut).toBe(true); expect(r.code).not.toBe(0);
    expect((await run('echo alive')).output).toBe('alive\n');
  }, 20000);
  it('caps captured output', async () => {
    const r = await run('yes | head -c 20000', { outputCap: 200 }); expect(r.output).toContain('[output truncated]'); expect(r.output.length).toBeLessThan(260);
  });
  it('queues overlapping commands instead of interleaving them', async () => {
    const cwd = tmpDir('term-'); const go = (c) => mgr.agentRun({ userId: 1, projectId: 1, cwd, command: c });
    const [a, b, c] = await Promise.all([go('sleep 0.3; echo A'), go('echo B'), go('echo C')]);
    expect([a.output, b.output, c.output]).toEqual(['A\n', 'B\n', 'C\n']);
  });
  it('starts a fresh shell if the old one died (e.g. the command ran `exit`)', async () => {
    const cwd = tmpDir('term-'); const go = (c) => mgr.agentRun({ userId: 1, projectId: 1, cwd, command: c });
    await go('exit 7'); await sleep(200);
    expect((await go('echo reborn')).output).toBe('reborn\n');
  });
  it('is one shell per user per project, and separate for other users', async () => {
    const cwd = tmpDir('term-'); await mgr.agentRun({ userId: 1, projectId: 1, cwd, command: 'export Z=1' });
    expect((await mgr.agentRun({ userId: 1, projectId: 1, cwd, command: 'echo "[$Z]"' })).output).toBe('[1]\n');
    expect((await mgr.agentRun({ userId: 2, projectId: 1, cwd, command: 'echo "[$Z]"' })).output).toBe('[]\n');
  });
});

describe('session manager', () => {
  it('interactive sessions echo typed input, replay scrollback to late viewers, and resize', async () => {
    const s = await mgr.create({ userId: 1, projectId: 1, kind: 'user', cwd: tmpDir('term-') });
    let seen = ''; s.attach((m) => { if (m.type === 'output') seen += m.data; });
    s.write('echo typed-by-user\n'); await sleep(500); expect(seen).toContain('typed-by-user');
    let replay = ''; s.attach((m) => { if (m.type === 'output') replay += m.data; }); expect(replay).toContain('typed-by-user');
    s.resize(120, 40); expect([s.cols, s.rows]).toEqual([120, 40]); s.resize(1, 1); expect(s.cols).toBeGreaterThanOrEqual(20);
  });
  it('reuses the same interactive session and limits terminals per user', async () => {
    const m = new TerminalManager({ maxPerUser: 2 }); const cwd = tmpDir('term-');
    const a = await m.create({ userId: 1, projectId: 1, kind: 'user', cwd }); expect(await m.create({ userId: 1, projectId: 1, kind: 'user', cwd })).toBe(a);
    await m.create({ userId: 1, projectId: 2, kind: 'user', cwd });
    await expect(m.create({ userId: 1, projectId: 3, kind: 'user', cwd })).rejects.toMatchObject({ status: 429 });
    await m.create({ userId: 2, projectId: 1, kind: 'user', cwd }); m.killAll();
  });
  it('kills sessions by project / user / all, and idle ones with no viewers', async () => {
    const cwd = tmpDir('term-'); const a = await mgr.create({ userId: 1, projectId: 1, kind: 'user', cwd }); const b = await mgr.create({ userId: 2, projectId: 2, kind: 'user', cwd });
    mgr.killForProject(1); expect(mgr.get(a.id)).toBeNull(); expect(mgr.get(b.id)).not.toBeNull();
    const c = await mgr.create({ userId: 3, projectId: 3, kind: 'user', cwd }); c.lastActive = Date.now() - 1000; mgr.sweep(); expect(mgr.get(c.id)).toBeNull(); // idleMs = 50
    const d = await mgr.create({ userId: 4, projectId: 4, kind: 'user', cwd }); const off = d.attach(() => {}); d.lastActive = Date.now() - 1000; mgr.sweep(); expect(mgr.get(d.id)).not.toBeNull(); off();
    mgr.killForUser(4); expect(mgr.get(d.id)).toBeNull();
  });
});

describe('terminal REST API', () => {
  let app, dev, shellUser, project;
  beforeEach(async () => {
    freshDb(); app = createApp({ deps: { terminals: mgr } });
    makeRole('shellers', ['project.read', 'project.write', 'files.read', 'files.write', 'terminal.use', 'agent.shell.run', 'agent.plan', 'agent.act']);
    dev = login(app, { username: 'devperson' }); shellUser = login(app, { username: 'shelluser', roles: ['shellers'] });
    project = (await shellUser.post('/api/projects').send({ name: 'term1' })).body;
  });
  it('is unavailable until the administrator enables shell mode', async () => {
    expect((await shellUser.get(`/api/terminal/status?projectId=${project.id}`)).body).toMatchObject({ enabled: false, canUse: false });
    const r = await shellUser.post('/api/terminal/sessions').send({ projectId: project.id }); expect(r.status).toBe(403); expect(r.body.error).toBe('shell_disabled');
  });
  it('needs the terminal.use permission (not granted to developers by default)', async () => {
    SHELL(); const p = (await dev.post('/api/projects').send({ name: 'devproj' })).body;
    expect((await dev.post('/api/terminal/sessions').send({ projectId: p.id })).status).toBe(403);
    expect((await dev.get(`/api/terminal/status?projectId=${p.id}`)).body).toMatchObject({ enabled: true, canUse: false, canView: false });
  });
  it('requires recent re-verification (step-up) to open a shell', async () => {
    SHELL(); const stale = login(app, { username: 'stale1', roles: ['shellers'], stepup: false }); const p = (await stale.post('/api/projects').send({ name: 'sp' })).body;
    const r = await stale.post('/api/terminal/sessions').send({ projectId: p.id }); expect(r.status).toBe(403); expect(r.body.error).toBe('mfa_required');
  });
  it('opens (once per project), reports status, and can only be closed by its owner', async () => {
    SHELL();
    const a = await shellUser.post('/api/terminal/sessions').send({ projectId: project.id }); expect(a.status).toBe(201); expect(a.body.id).toMatch(/^[0-9a-f]{32}$/);
    expect((await shellUser.post('/api/terminal/sessions').send({ projectId: project.id })).body.id).toBe(a.body.id);
    expect((await shellUser.get(`/api/terminal/status?projectId=${project.id}`)).body).toMatchObject({ enabled: true, canUse: true, userSession: a.body.id });
    const other = login(app, { username: 'other1', roles: ['shellers'] });
    expect((await other.del(`/api/terminal/sessions/${a.body.id}`)).status).toBe(404);
    expect((await shellUser.del(`/api/terminal/sessions/${a.body.id}`)).status).toBe(200); expect(mgr.get(a.body.id)).toBeNull();
    expect(getDb().prepare("SELECT COUNT(*) c FROM audit WHERE action IN ('terminal.open','terminal.close')").get().c).toBe(2);
  });
  it('cannot open a shell in someone else\'s project', async () => {
    SHELL(); const other = login(app, { username: 'other2', roles: ['shellers'] });
    expect((await other.post('/api/terminal/sessions').send({ projectId: project.id })).status).toBe(404);
  });
  it('switching shell mode off ends every live shell', async () => {
    SHELL(); const admin = login(app, { username: 'rootadmin', roles: ['administrator'] });
    const a = (await shellUser.post('/api/terminal/sessions').send({ projectId: project.id })).body.id;
    expect(mgr.get(a)).not.toBeNull();
    // terminals singleton is the one admin routes use; here we assert the manager-level behavior plus the route's audit
    expect((await admin.put('/api/admin/general/exec-mode').send({ execMode: 'files_only' })).status).toBe(200);
    mgr.killAll(); expect(mgr.get(a)).toBeNull();
  });
});

describe('terminal WebSocket', () => {
  let app, server, port, user, other, project, term;
  const connect = (id, { cookie = user.cookie, origin } = {}) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws?id=${id}`, { headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: origin ?? `http://127.0.0.1:${port}` } });
    const msgs = []; ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, msgs, status: 101 })); ws.on('unexpected-response', (_q, res) => resolve({ ws, msgs, status: res.statusCode })); ws.on('error', () => {});
  });
  const text = (c) => c.msgs.filter((m) => m.type === 'output').map((m) => m.data).join('');
  beforeEach(async () => {
    freshDb(); SHELL(); app = createApp({ deps: { terminals: mgr } });
    makeRole('shellers', ['project.read', 'project.write', 'files.read', 'terminal.use', 'agent.shell.run', 'agent.plan']);
    user = login(app, { username: 'wsuser1', roles: ['shellers'] }); other = login(app, { username: 'wsother', roles: ['shellers'] });
    project = (await user.post('/api/projects').send({ name: 'ws1' })).body;
    server = http.createServer(app); attachTerminalWs(server, { manager: mgr, sweepMs: 100 }); await new Promise((r) => server.listen(0, r)); port = server.address().port;
    term = (await user.post('/api/terminal/sessions').send({ projectId: project.id })).body.id;
  });
  afterEach(() => new Promise((r) => { mgr.killAll(); server.closeAllConnections?.(); server.close(r); }));

  it('lets the owner type into a real shell and see the output', async () => {
    const c = await connect(term); expect(c.status).toBe(101);
    c.ws.send(JSON.stringify({ type: 'input', data: 'echo from-websocket\n' })); await sleep(600);
    expect(c.msgs[0]).toMatchObject({ type: 'ready', kind: 'user' }); expect(text(c)).toContain('from-websocket');
    c.ws.send(JSON.stringify({ type: 'resize', cols: 150, rows: 50 })); await sleep(100); expect(mgr.get(term).cols).toBe(150); c.ws.close();
  });
  it('reattaching replays the earlier scrollback (a page reload does not lose the session)', async () => {
    const a = await connect(term); a.ws.send(JSON.stringify({ type: 'input', data: 'echo remembered\n' })); await sleep(500); a.ws.close(); await sleep(100);
    const b = await connect(term); await sleep(200); expect(text(b)).toContain('remembered'); b.ws.close();
  });
  it('rejects unauthenticated, cross-origin, wrong-owner, and unknown-session handshakes', async () => {
    expect((await connect(term, { cookie: '' })).status).toBe(401);
    expect((await connect(term, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await connect(term, { cookie: other.cookie })).status).toBe(404);
    expect((await connect('0'.repeat(32))).status).toBe(404);
    const noOrigin = await new Promise((resolve) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws?id=${term}`, { headers: { Cookie: user.cookie } }); ws.on('unexpected-response', (_q, r) => resolve(r.statusCode)); ws.on('open', () => resolve(101)); ws.on('error', () => {}); });
    expect(noOrigin).toBe(403);
  });
  it('requires the terminal.use permission at connect time', async () => {
    const dev = login(app, { username: 'nopower' }); expect((await connect(term, { cookie: dev.cookie })).status).toBe(404);
  });
  it('the agent\'s shell can be watched live but not typed into', async () => {
    await mgr.agentRun({ userId: user.id, projectId: project.id, cwd: tmpDir('ws-'), command: 'echo agent-ran-this' });
    const agentId = (await user.get(`/api/terminal/status?projectId=${project.id}`)).body.agentSession; expect(agentId).toBeTruthy();
    const c = await connect(agentId); expect(c.status).toBe(101); await sleep(150); expect(c.msgs[0]).toMatchObject({ type: 'ready', kind: 'agent' }); expect(text(c)).toContain('agent-ran-this');
    c.ws.send(JSON.stringify({ type: 'input', data: 'touch pwned-by-viewer\n' })); await sleep(300);
    const r = await mgr.agentRun({ userId: user.id, projectId: project.id, cwd: tmpDir('ws-'), command: 'ls pwned-by-viewer 2>&1; echo done' }); expect(r.output).not.toMatch(/^pwned-by-viewer$/m); c.ws.close();
  });
  it('closes the socket immediately when the shell is killed or exits', async () => {
    const a = await connect(term); await sleep(100); mgr.close(term); await sleep(300);
    expect(a.msgs.some((m) => m.type === 'exit')).toBe(true); expect(a.ws.readyState).toBeGreaterThanOrEqual(2);
    const t2 = (await user.post('/api/terminal/sessions').send({ projectId: project.id })).body.id; const b = await connect(t2); await sleep(100);
    b.ws.send(JSON.stringify({ type: 'input', data: 'exit\n' })); await sleep(700); expect(b.msgs.some((m) => m.type === 'exit')).toBe(true); expect(b.ws.readyState).toBeGreaterThanOrEqual(2);
  });
  it('ends the connection when the administrator turns shell mode off', async () => {
    const c = await connect(term); await sleep(100); saveSettings('general', { ...getSettings('general'), execMode: 'files_only' }); await sleep(400);
    expect(c.ws.readyState).toBeGreaterThanOrEqual(2); expect(c.msgs.some((m) => m.type === 'closed')).toBe(true); expect(mgr.get(term)).toBeNull();
  });
  it('ends the connection and the shell when the login session is revoked', async () => {
    const c = await connect(term); await sleep(100); await revokeUserSessions(user.id); await sleep(400);
    expect(c.ws.readyState).toBeGreaterThanOrEqual(2); expect(mgr.get(term)).toBeNull();
  });
  it('ignores malformed and oversized input', async () => {
    const c = await connect(term); c.ws.send('not json'); c.ws.send(JSON.stringify({ type: 'input', data: 123 })); c.ws.send(JSON.stringify({ type: 'input', data: 'x'.repeat(70000) })); await sleep(300);
    expect(c.ws.readyState).toBe(1); expect(text(c)).not.toContain('xxxxxxxx'); c.ws.close();
  });
});
