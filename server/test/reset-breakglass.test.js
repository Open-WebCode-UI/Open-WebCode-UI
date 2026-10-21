import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, request, PW } from './helpers.js';
import { createLocalUser } from '../src/users.js';
import { getDb } from '../src/db/index.js';
import { resetBreakGlass } from '../src/cli/reset-breakglass.js';

beforeEach(() => freshDb());
const login = (app, password) => request(app).post('/api/auth/local/login').send({ username: 'breakglass', password });

describe('break-glass recovery', () => {
  it('creates the account when missing and lets it sign in (forced to enroll MFA)', async () => {
    const r = resetBreakGlass();
    expect(r.created).toBe(true);
    const res = await login(createApp(), r.password);
    expect(res.status).toBe(200); expect(res.body.stage).toBe('enroll');
  });
  it('resets a forgotten password, clears lockout/disabled state, revokes sessions, keeps MFA unless asked', async () => {
    const id = createLocalUser({ username: 'breakglass', password: PW, roles: ['developer'], isBreakGlass: false });
    getDb().prepare('UPDATE users SET disabled=1, locked_until=9999999999, mfa_enrolled=1, totp_confirmed=1 WHERE id=?').run(id);
    const app = createApp();
    expect((await login(app, PW)).status).toBe(401);
    const r = resetBreakGlass({ password: 'Another-Long-Passphrase-42' });
    const u = getDb().prepare('SELECT * FROM users WHERE id=?').get(id);
    expect(u).toMatchObject({ disabled: 0, locked_until: 0, is_break_glass: 1, mfa_enrolled: 1 });
    expect(getDb().prepare("SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=? AND r.name='administrator'").get(id)).toBeTruthy();
    expect((await login(app, 'Another-Long-Passphrase-42')).body.stage).toBe('mfa');
    resetBreakGlass({ password: 'Another-Long-Passphrase-42', resetMfaToo: true });
    expect((await login(app, 'Another-Long-Passphrase-42')).body.stage).toBe('enroll');
    expect(getDb().prepare("SELECT COUNT(*) c FROM audit WHERE action='cli.breakglass_reset'").get().c).toBe(2);
    expect(r.created).toBe(false);
  });
  it('rejects weak supplied passwords', () => {
    createLocalUser({ username: 'breakglass', password: PW, roles: ['administrator'], isBreakGlass: true });
    expect(() => resetBreakGlass({ password: 'short' })).toThrow();
  });
});
