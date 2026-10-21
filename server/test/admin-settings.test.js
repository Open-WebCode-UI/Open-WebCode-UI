import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, login, request, PW, makeRole } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { getSettings, defaults } from '../src/settings.js';

let app, admin, dev;
beforeEach(() => { freshDb(); app = createApp(); admin = login(app, { username: 'rootadmin', roles: ['administrator'] }); dev = login(app, { username: 'devperson' }); });
const png = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64');

describe('General settings', () => {
  it('reads/updates app name, contact, and helpdesk info; validates input', async () => {
    const r = await admin.put('/api/admin/general').send({ appName: 'Acme Code', contactEmail: 'ops@acme.com', helpdeskPhone: '555-1234', helpdeskUrl: 'https://help.acme.com', helpdeskHours: '9-5' });
    expect(r.status).toBe(200); expect(r.body.appName).toBe('Acme Code');
    expect((await request(app).get('/api/public-config')).body.general).toMatchObject({ appName: 'Acme Code', helpdeskPhone: '555-1234', helpdeskUrl: 'https://help.acme.com' });
    expect((await admin.put('/api/admin/general').send({ contactEmail: 'not-an-email' })).status).toBe(400);
    expect((await admin.put('/api/admin/general').send({ helpdeskUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await admin.put('/api/admin/general').send({ maxUploadMb: 100000 })).status).toBe(400);
    expect((await admin.put('/api/admin/general').send({ execMode: 'anything' })).status).toBe(400);
  });
  it('requires settings.read/write', async () => {
    expect((await dev.get('/api/admin/general')).status).toBe(403);
    expect((await dev.put('/api/admin/general').send({ appName: 'x' })).status).toBe(403);
    makeRole('reader', ['settings.read']);
    const r = login(app, { username: 'reader1', roles: ['reader'] });
    expect((await r.get('/api/admin/general')).status).toBe(200);
    expect((await r.put('/api/admin/general').send({ appName: 'x' })).status).toBe(403);
  });
  it('exec mode defaults to files_only; only settings.write+step-up can change it; changes are audited', async () => {
    expect(getSettings('general').execMode).toBe('files_only');
    expect((await dev.put('/api/admin/general/exec-mode').send({ execMode: 'workspace_shell' })).status).toBe(403);
    expect((await admin.put('/api/admin/general/exec-mode').send({ execMode: 'bogus' })).status).toBe(400);
    expect((await admin.put('/api/admin/general/exec-mode').send({ execMode: 'workspace_shell' })).status).toBe(200);
    expect(getSettings('general').execMode).toBe('workspace_shell');
    const row = getDb().prepare("SELECT * FROM audit WHERE action='settings.exec_mode'").get();
    expect(row.target).toBe('workspace_shell'); expect(JSON.parse(row.detail).from).toBe('files_only');
  });
});

describe('Branding settings', () => {
  it('updates colors/fonts/theme with validation', async () => {
    const ok = await admin.put('/api/admin/branding').send({ primaryColor: '#112233', fontFamily: 'Inter, sans-serif', defaultMode: 'dark', borderRadius: 4 });
    expect(ok.status).toBe(200);
    expect((await request(app).get('/api/public-config')).body.branding).toMatchObject({ primaryColor: '#112233', defaultMode: 'dark' });
    expect((await admin.put('/api/admin/branding').send({ primaryColor: 'red' })).status).toBe(400);
    expect((await admin.put('/api/admin/branding').send({ fontFamily: 'x; } body{display:none' })).status).toBe(400);
    expect((await admin.put('/api/admin/branding').send({ fontUrl: 'http://insecure.example/f.css' })).status).toBe(400);
    expect((await dev.put('/api/admin/branding').send({ primaryColor: '#000000' })).status).toBe(403);
  });
  it('accepts png/svg logos, sanitizes svg, rejects other types, and oversize', async () => {
    expect((await admin.post('/api/admin/branding/upload').send({ kind: 'logo', dataUrl: png })).status).toBe(200);
    const svg = Buffer.from('<svg viewBox="0 0 1 1" onload="x()"><rect width="1" height="1"/></svg>').toString('base64');
    expect((await admin.post('/api/admin/branding/upload').send({ kind: 'favicon', dataUrl: `data:image/svg+xml;base64,${svg}` })).status).toBe(200);
    const stored = Buffer.from(getSettings('branding').faviconDataUrl.split(',')[1], 'base64').toString();
    expect(stored).toContain('<rect'); expect(stored).not.toContain('onload');
    const evil = Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64');
    expect((await admin.post('/api/admin/branding/upload').send({ kind: 'logo', dataUrl: `data:image/svg+xml;base64,${evil}` })).status).toBe(400);
    expect((await admin.post('/api/admin/branding/upload').send({ kind: 'logo', dataUrl: 'data:text/html;base64,PGI+' })).status).toBe(400);
    expect((await admin.post('/api/admin/branding/upload').send({ kind: 'logo', dataUrl: 'data:image/png;base64,' + 'A'.repeat(700_000) })).status).toBe(413);
  });
});

describe('Local authentication (user CRUD)', () => {
  it('creates, edits, disables, and deletes local users with role assignment', async () => {
    const c = await admin.post('/api/admin/users').send({ username: 'newdev', password: PW, email: 'n@x.com', firstName: 'N', lastName: 'D', roles: ['developer'] });
    expect(c.status).toBe(201); expect(c.body).toMatchObject({ source: 'local', roles: ['developer'], mustChangePassword: true });
    expect(JSON.stringify(c.body)).not.toMatch(/password_hash|\$2/);
    const id = c.body.id;
    expect((await admin.put(`/api/admin/users/${id}`).send({ roles: ['administrator'], lastName: 'Z' })).body).toMatchObject({ roles: ['administrator'], lastName: 'Z' });
    expect((await admin.put(`/api/admin/users/${id}`).send({ disabled: true })).body.disabled).toBe(true);
    expect((await admin.post('/api/admin/users').send({ username: 'newdev', password: PW })).status).toBe(409);
    expect((await admin.post('/api/admin/users').send({ username: 'weak1', password: 'short' })).status).toBe(400);
    expect((await admin.del(`/api/admin/users/${id}`)).status).toBe(200);
    expect((await dev.post('/api/admin/users').send({ username: 'x', password: PW })).status).toBe(403);
  });
  it('protects the last administrator and self-deletion', async () => {
    expect((await admin.del(`/api/admin/users/${admin.id}`)).body.error).toBe('cannot_delete_self');
    expect((await admin.put(`/api/admin/users/${admin.id}`).send({ roles: ['developer'] })).body.error).toBe('last_administrator');
    expect((await admin.put(`/api/admin/users/${admin.id}`).send({ disabled: true })).body.error).toBe('last_administrator');
  });
  it('SAML users cannot get local passwords or break-glass flags', async () => {
    const id = Number(getDb().prepare("INSERT INTO users (source,email,idp_entity_id,name_id) VALUES ('saml','s@x.com','idp','n1')").run().lastInsertRowid);
    expect((await admin.put(`/api/admin/users/${id}`).send({ password: PW })).body.error).toBe('saml_user_no_password');
    expect((await admin.put(`/api/admin/users/${id}`).send({ isBreakGlass: true })).body.error).toBe('saml_user_no_breakglass');
    const list = (await admin.get('/api/admin/users')).body;
    expect(list.find((x) => x.id === id).source).toBe('saml');
  });
  it('disabling a user revokes their sessions immediately', async () => {
    const target = login(app, { username: 'victim1' });
    expect((await target.get('/api/projects')).status).toBe(200);
    await admin.put(`/api/admin/users/${target.id}`).send({ disabled: true });
    expect((await target.get('/api/projects')).status).toBe(401);
  });
});

describe('Security settings (MFA enforcement)', () => {
  it('defaults require MFA for administrators; enforcement settings validate and need step-up', async () => {
    expect(getSettings('security').requireMfaRoles).toEqual(['administrator']);
    expect((await admin.put('/api/admin/security').send({ requireMfaEveryone: true })).status).toBe(200);
    expect((await admin.put('/api/admin/security').send({ requireMfaEveryone: true, samlRequiredAuthnContexts: [], samlRequiredAmr: [] })).status).toBe(400);
    const trust = { requireMfaEveryone: true, samlRequiredAuthnContexts: [], samlRequiredAmr: [], samlTrustIdpMfa: true };
    expect((await admin.put('/api/admin/security').send(trust)).body.error).toBe('saml_not_enabled'); // SAML not enabled yet
    expect((await admin.put('/api/admin/security').send({ passwordMinLength: 3 })).status).toBe(400);
    expect((await dev.put('/api/admin/security').send({ requireMfaEveryone: false })).status).toBe(403);
    const stale = login(app, { username: 'staleadm', roles: ['administrator'], stepup: false });
    expect((await stale.put('/api/admin/security').send({ mfaGraceDays: 1 })).body.error).toBe('mfa_required');
  });
});

describe('Roles & group mapping', () => {
  it('manages custom roles, group mappings, and prevents deleting built-ins', async () => {
    const role = (await admin.post('/api/admin/roles').send({ name: 'Auditor', permissions: ['audit.read', 'project.read'] })).body;
    expect((await admin.put('/api/admin/group-map').send({ mappings: [{ groupValue: 'CN=Auditors,OU=G', roleId: role.id }] })).status).toBe(200);
    const list = (await admin.get('/api/admin/roles')).body;
    expect(list.groupMap).toEqual([{ groupValue: 'CN=Auditors,OU=G', roleId: role.id }]);
    expect((await admin.put('/api/admin/group-map').send({ mappings: [{ groupValue: 'x', roleId: 9999 }] })).status).toBe(400);
    const devRole = list.roles.find((r) => r.name === 'developer');
    expect((await admin.del(`/api/admin/roles/${devRole.id}`)).body.error).toBe('builtin_role');
    expect((await admin.del(`/api/admin/roles/${role.id}`)).status).toBe(200);
    expect((await dev.post('/api/admin/roles').send({ name: 'x', permissions: [] })).status).toBe(403);
  });
});

describe('SSO button text', () => {
  it('defaults to "Log in with SSO" and follows the saml setting in the public config', async () => {
    const { publicConfig, getSettings, saveSettings } = await import('../src/settings.js');
    freshDb();
    expect(publicConfig().ssoButtonText).toBe('Log in with SSO');
    saveSettings('saml', { ...getSettings('saml'), buttonText: 'Sign in with Acme' });
    expect(publicConfig().ssoButtonText).toBe('Sign in with Acme');
  });
});
