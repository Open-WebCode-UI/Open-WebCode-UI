import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, login } from './helpers.js';

let app, u;
beforeEach(() => { freshDb(); app = createApp(); u = login(app, { username: 'dee' }); });

describe('GET /api/agent/status (Platform status pane)', () => {
  it('returns the same facts as /status, with the project when one is given', async () => {
    const p = (await u.post('/api/projects').send({ name: 'web-app' })).body;
    const r = await u.get(`/api/agent/status?projectId=${p.id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ connection: { status: 'connected' }, server: { name: 'OpenWebCodeUI' }, user: { username: 'dee' }, project: { id: p.id, name: 'web-app' } });
  });
  it('works without a project', async () => {
    const r = await u.get('/api/agent/status');
    expect(r.status).toBe(200); expect(r.body.project).toBeNull();
  });
  it('rejects a bad project id and a project the user does not own', async () => {
    expect((await u.get('/api/agent/status?projectId=abc')).status).toBe(400);
    expect((await u.get('/api/agent/status?projectId=99999')).status).toBeGreaterThanOrEqual(403);
  });
  it('needs a signed-in user with agent access', async () => {
    expect((await (await import('./helpers.js')).request(app).get('/api/agent/status')).status).toBe(401);
    const none = login(app, { username: 'viewer', roles: [] });
    expect((await none.get('/api/agent/status')).status).toBe(403);
  });
});
