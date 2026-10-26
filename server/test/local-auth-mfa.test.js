import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, request, PW, totp, login } from './helpers.js';
import { createLocalUser } from '../src/users.js';
import { getDb } from '../src/db/index.js';
import { decrypt } from '../src/crypto.js';
import { saveSettings, getSettings } from '../src/settings.js';
import { useRecoveryCode } from '../src/auth/mfa.js';

let app;
beforeEach(() => { freshDb(); app = createApp(); });
const cookieOf = (res) => res.headers['set-cookie']?.[0]?.split(';')[0];
const bg = (extra = {}) => createLocalUser({ username: 'breakglass', password: PW, roles: ['administrator'], isBreakGlass: true, ...extra });
const doLogin = (u = 'breakglass', p = PW) => request(app).post('/api/auth/local/login').send({ username: u, password: p });
const authed = (cookie, csrf) => ({ post: (u) => request(app).post(u).set('Cookie', cookie).set('x-csrf-token', csrf), get: (u) => request(app).get(u).set('Cookie', cookie) });

async function enroll() {
  bg();
  const r = await doLogin();
  expect(r.body.stage).toBe('enroll');
  const s = authed(cookieOf(r), r.body.csrf);
  const setup = await s.post('/api/auth/mfa/totp/setup').send({});
  expect(setup.body.qr).toMatch(/^data:image\/png/);
  const conf = await s.post('/api/auth/mfa/totp/confirm').send({ code: totp(setup.body.secret) });
  expect(conf.status).toBe(200); expect(conf.body.recoveryCodes).toHaveLength(10);
  return { secret: setup.body.secret, recovery: conf.body.recoveryCodes, cookie: cookieOf(conf) ?? cookieOf(r), csrf: conf.body.csrf };
}

describe('local (break-glass) authentication', () => {
  it('first login forces MFA enrollment: no privileges until completed', async () => {
    bg();
    const r = await doLogin();
    expect(r.status).toBe(200); expect(r.body.stage).toBe('enroll');
    expect((await request(app).get('/api/admin/users').set('Cookie', cookieOf(r))).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookieOf(r))).body.user.permissions).toBeUndefined();
  });
  it('after enrollment, login requires a TOTP code (or a single-use recovery code)', async () => {
    const e = await enroll();
    const r = await doLogin();
    expect(r.body.stage).toBe('mfa');
    const s = authed(cookieOf(r), r.body.csrf);
    expect((await s.post('/api/auth/mfa/verify').send({ code: '000000' })).status).toBe(401);
    // recovery code works once
    const ok = await s.post('/api/auth/mfa/verify').send({ code: e.recovery[0] });
    expect(ok.status).toBe(200); expect(ok.body.stage).toBe('full');
    expect(await useRecoveryCode(1, e.recovery[0])).toBe(false);
    const r2 = await doLogin();
    expect((await authed(cookieOf(r2), r2.body.csrf).post('/api/auth/mfa/verify').send({ code: e.recovery[0] })).status).toBe(401);
  });
  it('a TOTP code cannot be replayed (the enrollment code is already spent for its time step)', async () => {
    const e = await enroll();
    const r = await doLogin();
    const replay = await authed(cookieOf(r), r.body.csrf).post('/api/auth/mfa/verify').send({ code: totp(e.secret) });
    expect(replay.status).toBe(401);
    // a code from the next step is accepted, and then cannot be reused
    getDb().prepare('UPDATE users SET totp_last_step=totp_last_step-1').run();
    const code = totp(e.secret);
    const ok = await authed(cookieOf(r), r.body.csrf).post('/api/auth/mfa/verify').send({ code });
    expect(ok.status).toBe(200);
    const r2 = await doLogin();
    expect((await authed(cookieOf(r2), r2.body.csrf).post('/api/auth/mfa/verify').send({ code })).status).toBe(401);
  });
  it('TOTP secret is stored encrypted', async () => {
    const e = await enroll();
    const enc = getDb().prepare('SELECT totp_secret_enc FROM users').get().totp_secret_enc;
    expect(enc).not.toContain(e.secret); expect(decrypt(enc)).toBe(e.secret);
  });
  it('regular local users can sign in by default; can be restricted to break-glass accounts, or disabled entirely', async () => {
    createLocalUser({ username: 'regular1', password: PW, roles: ['developer'] });
    bg();
    expect((await doLogin('regular1')).status).toBe(200);
    saveSettings('security', { ...getSettings('security'), breakGlassOnly: true });
    expect((await doLogin('regular1')).status).toBe(401);
    expect((await doLogin()).status).toBe(200);
    saveSettings('security', { ...getSettings('security'), localLoginEnabled: false });
    expect((await doLogin()).status).toBe(401);
  });
  it('generic errors (no user enumeration), lockout after N failures, and audit entries', async () => {
    bg();
    const unknown = await doLogin('nobody', 'x'), wrong = await doLogin('breakglass', 'wrong-password-123');
    expect(unknown.status).toBe(401); expect(wrong.body).toEqual(unknown.body);
    for (let i = 0; i < 6; i++) await doLogin('breakglass', 'wrong-password-123');
    expect((await doLogin()).status).toBe(401); // locked even with the right password
    const u = getDb().prepare('SELECT locked_until, lockouts FROM users').get();
    expect(u.locked_until).toBeGreaterThan(Date.now() / 1000); expect(u.lockouts).toBe(1);
    const actions = getDb().prepare('SELECT action FROM audit').all().map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.local.failed', 'auth.local.locked', 'auth.local.denied']));
  });
  it('rate limits login attempts per IP', async () => {
    let last;
    for (let i = 0; i < 25; i++) last = await doLogin('nobody', 'x');
    expect(last.status).toBe(429);
  });
  it('rejects weak/guessable passwords and passwords containing the username', () => {
    expect(() => createLocalUser({ username: 'x1', password: 'short' })).toThrow();
    expect(() => createLocalUser({ username: 'breakglass', password: 'breakglass-123456' })).toThrow();
    expect(() => createLocalUser({ username: 'y1', password: 'aaaaaaaaaaaaaaaa' })).toThrow();
    expect(getDb().prepare('SELECT password_hash FROM users').all()).toEqual([]);
  });
  it('passwords are hashed with bcrypt', () => {
    bg();
    expect(getDb().prepare('SELECT password_hash h FROM users').get().h).toMatch(/^bcrypt-sha256\$\$2[aby]\$12\$/);
  });
  it('step-up: sensitive actions need recent re-verification; SAML users are sent to the IdP', async () => {
    const e = await enroll();
    const r = await doLogin();
    const s = authed(cookieOf(r), r.body.csrf);
    const full = await s.post('/api/auth/mfa/verify').send({ code: e.recovery[1] });
    const cookie = cookieOf(full), csrf = full.body.csrf;
    getDb().prepare('UPDATE sessions SET stepup_at=0').run(); // simulate expiry
    const a = authed(cookie, csrf);
    const blocked = await request(app).put('/api/admin/general/exec-mode').set('Cookie', cookie).set('x-csrf-token', csrf).send({ execMode: 'workspace_shell' });
    expect(blocked.status).toBe(403); expect(blocked.body).toMatchObject({ error: 'mfa_required', stepup: true });
    expect((await a.post('/api/auth/stepup').send({ code: '111111' })).status).toBe(401);
    expect((await a.post('/api/auth/stepup').send({ code: e.recovery[2] })).status).toBe(200);
    const ok = await request(app).put('/api/admin/general/exec-mode').set('Cookie', cookie).set('x-csrf-token', csrf).send({ execMode: 'workspace_shell' });
    expect(ok.status).toBe(200); expect(getSettings('general').execMode).toBe('workspace_shell');
    expect(getDb().prepare("SELECT COUNT(*) c FROM audit WHERE action='settings.exec_mode'").get().c).toBe(1);
  });
  it('admins can reset a user\'s MFA (audited, revokes sessions)', async () => {
    await enroll();
    const admin = login(app, { username: 'otheradmin', roles: ['administrator'] });
    const r = await admin.post('/api/admin/users/1/reset-mfa');
    expect(r.status).toBe(200);
    expect(getDb().prepare('SELECT mfa_enrolled FROM users WHERE id=1').get().mfa_enrolled).toBe(0);
    expect(getDb().prepare("SELECT COUNT(*) c FROM audit WHERE action='mfa.reset'").get().c).toBe(1);
    const dev = login(app, { username: 'devperson' });
    expect((await dev.post('/api/admin/users/1/reset-mfa')).status).toBe(403);
  });
});
