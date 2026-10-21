import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, login, request, makeRole } from './helpers.js';
import { getSettings } from '../src/settings.js';

const choices = { appName: 'Acme Code', tagline: 'Ship it', primaryColor: '#112233', defaultMode: 'dark', memoryAllowed: false, coursesEnabled: false, userMcpAllowed: false, showSessionCost: true };

describe('first-run setup', () => {
  let app;
  beforeEach(() => { freshDb(); app = createApp(); });

  it('is closed to anonymous users and to roles without settings.write', async () => {
    expect((await request(app).get('/api/admin/setup')).status).toBe(401);
    const dev = login(app, { username: 'dev1' });
    expect((await dev.get('/api/admin/setup')).status).toBe(403);
    expect((await dev.post('/api/admin/setup/complete').send({ skip: true })).status).toBe(403);
  });

  it('starts incomplete with the current values', async () => {
    const a = login(app, { username: 'admin1', roles: ['administrator'] });
    const r = await a.get('/api/admin/setup');
    expect(r.status).toBe(200);
    expect(r.body.completed).toBe(false);
    expect(r.body.values.appName).toBe(getSettings('general').appName);
    expect(r.body.modelCount).toBe(0);
  });

  it('applies the choices once and marks setup complete', async () => {
    const a = login(app, { username: 'admin2', roles: ['administrator'] });
    const r = await a.post('/api/admin/setup/complete').send({ choices });
    expect(r.status).toBe(200);
    expect(r.body.completed).toBe(true);
    const g = getSettings('general'), b = getSettings('branding');
    expect([g.appName, g.memoryAllowed, g.coursesEnabled, g.userMcpAllowed, g.showSessionCost]).toEqual(['Acme Code', false, false, false, true]);
    expect([b.primaryColor, b.defaultMode]).toEqual(['#112233', 'dark']);
    expect(getSettings('setup')).toMatchObject({ completed: true, skipped: false });
    expect(getSettings('general').execMode).toBe('files_only');
  });

  it('skip changes nothing but ends the prompt', async () => {
    const a = login(app, { username: 'admin3', roles: ['administrator'] });
    const before = getSettings('general');
    expect((await a.post('/api/admin/setup/complete').send({ skip: true })).body.completed).toBe(true);
    expect(getSettings('general')).toEqual(before);
    expect(getSettings('setup').skipped).toBe(true);
  });

  it('a later submit cannot overwrite a finished setup', async () => {
    const a = login(app, { username: 'admin4', roles: ['administrator'] });
    await a.post('/api/admin/setup/complete').send({ choices });
    await a.post('/api/admin/setup/complete').send({ choices: { ...choices, appName: 'Other' } });
    expect(getSettings('general').appName).toBe('Acme Code');
  });

  it('rejects invalid choices without completing', async () => {
    const a = login(app, { username: 'admin5', roles: ['administrator'] });
    for (const bad of [{ ...choices, appName: '  ' }, { ...choices, primaryColor: 'red' }, { ...choices, execMode: 'workspace_shell', memoryAllowed: 'yes' }]) {
      expect((await a.post('/api/admin/setup/complete').send({ choices: bad })).status).toBe(400);
    }
    expect(getSettings('setup').completed).toBe(false);
  });

  it('leaves branding alone for a role without branding.write', async () => {
    const role = makeRole('settings-only', ['settings.write']);
    const a = login(app, { username: 'admin6', roles: [] });
    const { getDb } = await import('../src/db/index.js');
    getDb().prepare('INSERT INTO user_roles (user_id, role_id) SELECT id, ? FROM users WHERE username=?').run(role, 'admin6');
    await a.post('/api/admin/setup/complete').send({ choices });
    expect(getSettings('branding').primaryColor).not.toBe('#112233');
    expect(getSettings('general').appName).toBe('Acme Code');
  });
});
