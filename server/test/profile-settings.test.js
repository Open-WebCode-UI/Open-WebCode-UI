import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, login } from './helpers.js';
import { getDb } from '../src/db/index.js';

let app, u;
beforeEach(() => { freshDb(); app = createApp(); u = login(app, { username: 'dee' }); });

describe('profile account', () => {
  it('lets a local user change their name; display name follows; email is untouched', async () => {
    getDb().prepare("UPDATE users SET email='dee@x.test' WHERE id=?").run(u.id);
    const r = await u.put('/api/profile/account').send({ firstName: ' Dee ', lastName: 'Veloper' });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ firstName: 'Dee', lastName: 'Veloper', displayName: 'Dee Veloper', email: 'dee@x.test' });
  });
  it('rejects an empty name, unknown fields (e.g. email) and overlong names', async () => {
    expect((await u.put('/api/profile/account').send({ firstName: '', lastName: '' })).status).toBe(400);
    expect((await u.put('/api/profile/account').send({ firstName: 'A', lastName: 'B', email: 'evil@x.test' })).status).toBe(400);
    expect((await u.put('/api/profile/account').send({ firstName: 'A'.repeat(101), lastName: '' })).status).toBe(400);
    expect(getDb().prepare('SELECT email FROM users WHERE id=?').get(u.id).email).not.toBe('evil@x.test');
  });
  it('is refused for single sign-on users', async () => {
    getDb().prepare("UPDATE users SET source='saml', username=NULL, idp_entity_id='i', name_id='n' WHERE id=?").run(u.id);
    expect((await u.put('/api/profile/account').send({ firstName: 'A', lastName: 'B' })).status).toBe(403);
  });
});

describe('profile preferences', () => {
  it('returns defaults, then persists partial updates and includes them in /me', async () => {
    expect((await u.get('/api/profile/preferences')).body).toEqual({ colorMode: null, fontScale: 100, reduceMotion: false, highContrast: false, underlineLinks: false });
    const r = await u.put('/api/profile/preferences').send({ colorMode: 'dark', reduceMotion: true });
    expect(r.body).toMatchObject({ colorMode: 'dark', reduceMotion: true, fontScale: 100 });
    await u.put('/api/profile/preferences').send({ fontScale: 130 });
    const me = await u.get('/api/auth/me');
    expect(me.body.user.preferences).toMatchObject({ colorMode: 'dark', reduceMotion: true, fontScale: 130 });
  });
  it('rejects invalid values and unknown keys', async () => {
    for (const bad of [{ colorMode: 'neon' }, { fontScale: 400 }, { reduceMotion: 'yes' }, { admin: true }])
      expect((await u.put('/api/profile/preferences').send(bad)).status).toBe(400);
  });
  it('falls back to defaults when the stored value is corrupt', async () => {
    getDb().prepare("UPDATE users SET preferences='{not json' WHERE id=?").run(u.id);
    expect((await u.get('/api/profile/preferences')).body.fontScale).toBe(100);
  });
  it('requires authentication', async () => {
    const { default: request } = await import('supertest');
    expect((await request(app).get('/api/profile/preferences')).status).toBe(401);
  });
});
