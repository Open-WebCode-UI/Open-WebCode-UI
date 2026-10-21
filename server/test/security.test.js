import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, request, login, PW } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { audit, verifyAudit } from '../src/audit.js';
import { saveSettings, getSettings, publicConfig } from '../src/settings.js';
import { sanitizeSvg } from '../src/svg.js';
import { redact } from '../src/crypto.js';
import { createSession, loadSession, rotateSession } from '../src/auth/session.js';

let app;
beforeEach(() => { freshDb(); app = createApp(); });

describe('headers & CSRF', () => {
  it('sets security headers and a strict CSP', async () => {
    const res = await request(app).get('/api/public-config');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain("object-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('same-origin');
  });
  it('rejects state-changing requests without the CSRF token or from a foreign Origin', async () => {
    const u = login(app, { username: 'csrfuser' });
    const noToken = await request(app).post('/api/projects').set('Cookie', u.cookie).send({ name: 'p1' });
    expect(noToken.status).toBe(403); expect(noToken.body.error).toBe('csrf');
    const bad = await request(app).post('/api/projects').set('Cookie', u.cookie).set('x-csrf-token', 'nope').send({ name: 'p1' });
    expect(bad.status).toBe(403);
    const foreign = await request(app).post('/api/projects').set('Cookie', u.cookie).set('x-csrf-token', u.csrf).set('Origin', 'https://evil.example').send({ name: 'p1' });
    expect(foreign.status).toBe(403); expect(foreign.body.error).toBe('bad_origin');
    // an Origin that matches the Host the request was addressed to is same-origin (e.g. 127.0.0.1 vs localhost, dev proxy)
    const same = await request(app).post('/api/projects').set('Cookie', u.cookie).set('x-csrf-token', u.csrf).set('Host', 'localhost:5173').set('Origin', 'http://localhost:5173').send({ name: 'p2' });
    expect(same.status).toBe(201);
    expect((await u.post('/api/projects').send({ name: 'p1' })).status).toBe(201);
    expect((await request(app).post('/api/auth/local/login').set('Origin', 'https://evil.example').send({ username: 'a', password: 'b' })).status).toBe(403);
  });
});

describe('sessions', () => {
  it('rotation revokes the old id; idle and absolute timeouts and revocation end the session', () => {
    const id = login(app, { username: 'sessuser' }).id;
    const s = createSession(id);
    const n = rotateSession(s.id);
    expect(loadSession(s.id)).toBeNull(); expect(loadSession(n.id)).not.toBeNull();
    getDb().prepare('UPDATE sessions SET last_seen=last_seen-100000 WHERE id=?').run(n.id);
    expect(loadSession(n.id)).toBeNull(); // idle timeout
    const a = createSession(id); getDb().prepare('UPDATE sessions SET created_at=created_at-999999 WHERE id=?').run(a.id);
    expect(loadSession(a.id)).toBeNull(); // absolute timeout
    const b = createSession(id); getDb().prepare('UPDATE users SET disabled=1 WHERE id=?').run(id);
    expect(loadSession(b.id)).toBeNull(); // disabled users lose sessions
  });
  it('"sign out all sessions" revokes others and keeps the current one', async () => {
    const u = login(app, { username: 'multisess' });
    const other = createSession(u.id);
    expect((await u.post('/api/auth/sessions/revoke-all')).status).toBe(200);
    expect(loadSession(other.id)).toBeNull();
    expect((await u.get('/api/auth/me')).status).toBe(200);
  });
  it('session cookie is HttpOnly + SameSite=Lax', async () => {
    createApp();
    const { createLocalUser } = await import('../src/users.js');
    createLocalUser({ username: 'cookieuser', password: PW, roles: ['developer'] });
    const r = await request(app).post('/api/auth/local/login').send({ username: 'cookieuser', password: PW });
    expect(r.status).toBe(200);
    const cookie = r.headers['set-cookie'].join(';');
    expect(cookie).toMatch(/HttpOnly/i); expect(cookie).toMatch(/SameSite=Lax/i);
  });
  it('forces a password change before anything else', async () => {
    const u = login(app, { username: 'mustchange' });
    getDb().prepare('UPDATE users SET must_change_password=1 WHERE id=?').run(u.id);
    expect((await u.get('/api/projects')).body.error).toBe('password_change_required');
    expect((await u.post('/api/auth/password').send({ current: PW, next: 'A-brand-new-Passphrase-77' })).status).toBe(200);
    expect((await u.get('/api/projects')).status).toBe(200);
  });
});

describe('audit log', () => {
  it('hash chain verifies and detects tampering', () => {
    audit(1, 'a', 't', { n: 1 }); audit(1, 'b', 't', { n: 2 }); audit(2, 'c', null, { password: 'hunter2' });
    expect(verifyAudit()).toMatchObject({ ok: true, count: 3 });
    expect(getDb().prepare('SELECT detail FROM audit WHERE action=?').get('c').detail).not.toContain('hunter2');
    getDb().prepare("UPDATE audit SET action='tampered' WHERE action='b'").run();
    expect(verifyAudit().ok).toBe(false);
  });
  it('detects row deletion', () => {
    audit(1, 'a'); audit(1, 'b'); audit(1, 'c');
    getDb().prepare("DELETE FROM audit WHERE action='b'").run();
    expect(verifyAudit().ok).toBe(false);
  });
  it('audit API requires audit.read', async () => {
    const dev = login(app, { username: 'devperson' }), adm = login(app, { username: 'auditadm', roles: ['administrator'] });
    expect((await dev.get('/api/admin/audit')).status).toBe(403);
    const r = await adm.get('/api/admin/audit');
    expect(r.status).toBe(200); expect(r.body.integrity.ok).toBe(true);
  });
  it('audit API paginates newest-first with a keyset cursor', async () => {
    const adm = login(app, { username: 'auditpager', roles: ['administrator'] });
    for (let i = 0; i < 5; i++) audit('t', `page.${i}`);
    const p1 = (await adm.get('/api/admin/audit?limit=2')).body;
    expect(p1.rows).toHaveLength(2); expect(p1.hasMore).toBe(true); expect(p1.integrity.ok).toBe(true);
    const p2 = (await adm.get(`/api/admin/audit?limit=2&before=${p1.nextBefore}`)).body;
    expect(p2.rows).toHaveLength(2); expect(p2.rows[0].id).toBeLessThan(p1.rows[1].id); expect(p2.integrity).toBeUndefined();
  });
});

describe('misc hardening', () => {
  it('public config exposes only the public subset', () => {
    saveSettings('general', { ...getSettings('general'), contactEmail: 'c@x.com', helpdeskEmail: 'help@x.com', maxUploadMb: 7, secretGlobs: ['.env'] });
    const p = publicConfig();
    expect(p.general.helpdeskEmail).toBe('help@x.com');
    expect(JSON.stringify(p)).not.toMatch(/secretGlobs|execMode|maxUploadMb|spPrivateKey|idpCerts/);
  });
  it('SVG sanitizer strips scripts, handlers, foreign objects, and external refs', () => {
    expect(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).toBeNull();
    expect(sanitizeSvg('<svg><foreignObject><iframe/></foreignObject></svg>')).toBeNull();
    const clean = sanitizeSvg('<svg viewBox="0 0 1 1" onload="alert(1)"><rect width="1" height="1" fill="red" onclick="x()"/><path d="M0 0" fill="url(https://evil/x)"/></svg>');
    expect(clean).not.toMatch(/onload|onclick|evil/); expect(clean).toContain('<rect');
    expect(sanitizeSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>')).toBeNull();
    expect(sanitizeSvg('<html></html>')).toBeNull();
  });
  it('log redaction masks secrets', () => { expect(redact({ Authorization: 'Bearer x', ok: 1 })).toEqual({ Authorization: '[REDACTED]', ok: 1 }); });
  it('refuses to start in production over plain http', async () => {
    const { config } = await import('../src/config.js');
    const saved = { isProd: config.isProd, insecure: config.allowInsecureDev };
    config.isProd = true; config.allowInsecureDev = false;
    expect(() => createApp()).toThrow(/https/);
    Object.assign(config, { isProd: saved.isProd, allowInsecureDev: saved.insecure });
  });
});
