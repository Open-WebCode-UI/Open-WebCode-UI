import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, login, request } from './helpers.js';

describe('onboarding tutorial state', () => {
  let app;
  beforeEach(() => { freshDb(); app = createApp(); });

  it('requires a signed-in user', async () => {
    for (const [m, u] of [['get', '/api/user/onboarding'], ['post', '/api/user/onboarding/update'], ['post', '/api/user/onboarding/complete']]) {
      expect((await request(app)[m](u)).status, u).toBe(401);
    }
  });

  it('starts incomplete at step 0 for a user who never began', async () => {
    const u = login(app, { username: 'newbie', roles: [] });
    const r = await u.get('/api/user/onboarding');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ isCompleted: false, lastStepIndex: 0 });
  });

  it('saves progress so the tour can resume', async () => {
    const u = login(app, { username: 'resumer' });
    expect((await u.post('/api/user/onboarding/update').send({ stepIndex: 3 })).body).toEqual({ isCompleted: false, lastStepIndex: 3 });
    expect((await u.get('/api/user/onboarding')).body.lastStepIndex).toBe(3);
  });

  it('rejects invalid step indexes', async () => {
    const u = login(app, { username: 'badstep' });
    for (const stepIndex of [-1, 1.5, 'x', 1000, undefined]) expect((await u.post('/api/user/onboarding/update').send({ stepIndex })).status, String(stepIndex)).toBe(400);
  });

  it('completing persists, and a late progress write cannot un-complete it', async () => {
    const u = login(app, { username: 'finisher' });
    await u.post('/api/user/onboarding/update').send({ stepIndex: 2 });
    expect((await u.post('/api/user/onboarding/complete')).body.isCompleted).toBe(true);
    expect((await u.post('/api/user/onboarding/update').send({ stepIndex: 1 })).body.isCompleted).toBe(true);
    expect((await u.get('/api/user/onboarding')).body.isCompleted).toBe(true);
  });

  it('restart re-opens a finished tour from the given step', async () => {
    const u = login(app, { username: 'replayer' });
    await u.post('/api/user/onboarding/complete');
    expect((await u.post('/api/user/onboarding/update').send({ stepIndex: 0, restart: true })).body).toEqual({ isCompleted: false, lastStepIndex: 0 });
  });

  it('keeps each user\'s progress separate', async () => {
    const a = login(app, { username: 'alice' }), b = login(app, { username: 'bobby' });
    await a.post('/api/user/onboarding/complete');
    expect((await b.get('/api/user/onboarding')).body.isCompleted).toBe(false);
  });
});
