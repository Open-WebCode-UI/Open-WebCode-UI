import { sqlDb } from './db-sql.js';
import { describe, it, expect, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { freshDb, createApp, login, request } from './helpers.js';
import { createLocalUser, hashPassword, verifyPassword, PASSWORD_MAX } from '../src/users.js';


let app;
beforeEach(async () => { await freshDb(); app = createApp(); });
const signIn = (password, username = 'breakglass') => request(app).post('/api/auth/local/login').send({ username, password });
const long = (n, seed = 'Tr0ub4dor&3-correct-horse-') => (seed.repeat(Math.ceil(n / seed.length))).slice(0, n);

describe('long passwords', () => {
  it('has an effectively unlimited maximum', () => { expect(PASSWORD_MAX).toBeGreaterThanOrEqual(100_000); });

  it.each([100, 1_000, 10_000, 100_000])('accepts and verifies a %i-character password end to end', async (n) => {
    const pw = long(n);
    await createLocalUser({ username: 'breakglass', password: pw, roles: ['administrator'], isBreakGlass: true });
    const ok = await signIn(pw);
    expect(ok.status).toBe(200); expect(ok.body.stage).toBe('enroll');
    expect((await signIn('X' + pw.slice(1))).status).toBe(401); // same length, first character differs
  });

  it('every character counts: bcrypt\'s 72-byte truncation does not apply', () => {
    const a = long(80), b = a.slice(0, 72) + 'DIFFERENT-TAIL';
    const h = hashPassword(a);
    expect(verifyPassword(a, h)).toBe(true);
    expect(verifyPassword(b, h)).toBe(false); // same first 72 bytes, different tail
    expect(verifyPassword(a.slice(0, 72), h)).toBe(false);
    expect(bcrypt.compareSync(b, bcrypt.hashSync(a, 4))).toBe(true); // demonstrates the plain-bcrypt flaw we avoid
  });

  it('supports unicode, spaces, and NUL bytes', () => {
    for (const pw of ['correct horse battery staple – żółć 日本語 🔐🔐🔐', '   leading and trailing spaces   ', 'with\0nul-byte-in-the-middle-of-it']) {
      const h = hashPassword(pw);
      expect(verifyPassword(pw, h)).toBe(true); expect(verifyPassword(pw + 'x', h)).toBe(false);
    }
  });

  it('rejects only absurd lengths (> 100,000) with a clear message', async () => {
    try { await createLocalUser({ username: 'toolong1', password: long(PASSWORD_MAX + 1) }); throw new Error('should have thrown'); }
    catch (e) { expect(e.message).toBe('weak_password'); expect(e.extra.message).toMatch(/at most 100000/); }
    await createLocalUser({ username: 'breakglass', password: long(1000), roles: ['administrator'], isBreakGlass: true });
    expect((await signIn(long(PASSWORD_MAX + 1))).status).toBe(400);
  });

  it('long passwords work through the admin API and the change-password endpoint', async () => {
    const admin = await login(app, { username: 'rootadmin', roles: ['administrator'] });
    const pw = long(5000, 'Admin-Created-Passphrase-');
    const c = await admin.post('/api/admin/users').send({ username: 'longpw-user', password: pw, roles: ['developer'], isBreakGlass: true, mustChange: false });
    expect(c.status).toBe(201);
    expect((await signIn(pw, 'longpw-user')).status).toBe(200);
    const u = await login(app, { username: 'changer1' });
    const next = long(20_000, 'Brand-New-Passphrase-');
    expect((await u.post('/api/auth/password').send({ current: 'Correct-Horse-Battery-9', next })).status).toBe(200);
    expect(verifyPassword(next, (await sqlDb().prepare('SELECT password_hash h FROM users WHERE id=?').get(u.id)).h)).toBe(true);
  });

  it('legacy plain-bcrypt hashes still verify and are upgraded at next sign-in', async () => {
    const id = await createLocalUser({ username: 'breakglass', password: long(30), roles: ['administrator'], isBreakGlass: true });
    (await sqlDb().prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(long(30), 4), id));
    expect((await signIn(long(30))).status).toBe(200);
    expect((await sqlDb().prepare('SELECT password_hash h FROM users WHERE id=?').get(id)).h).toMatch(/^bcrypt-sha256\$/);
    expect((await signIn(long(30))).status).toBe(200); // still works after the upgrade
  });
});
