import { sqlDb } from './db-sql.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, createApp, login, makeRole, request } from './helpers.js';
import { userPermissions } from '../src/auth/rbac.js';
import { setUserRoles } from '../src/users.js';
import { ALL_PERMISSIONS } from '../src/permissions.js';

import { registry } from '../src/http.js';

let app;
beforeEach(async () => { await freshDb(); app = createApp(); });

describe('RBAC', () => {
  it('administrator has every permission and cannot be edited', async () => {
    const admin = await login(app, { username: 'adm', roles: ['administrator'] });
    expect([...(await userPermissions(admin.id))].sort()).toEqual([...ALL_PERMISSIONS].sort());
    const adminRole = (await sqlDb().prepare("SELECT id FROM roles WHERE name='administrator'").get()).id;
    const res = await admin.put(`/api/admin/roles/${adminRole}`).send({ name: 'administrator', permissions: ['project.read'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('administrator_immutable');
  });
  it('built-in chat roles grant chat tabs but no agent or project access', async () => {
    const g = await login(app, { username: 'cg', roles: ['chat-general'] });
    const gc = await login(app, { username: 'cgc', roles: ['chat-general-coding'] });
    const pg = await userPermissions(g.id), pgc = await userPermissions(gc.id);
    expect(pg.has('chat.general.use')).toBe(true); expect(pg.has('chat.use')).toBe(false);
    expect(pgc.has('chat.general.use') && pgc.has('chat.use')).toBe(true);
    for (const p of [pg, pgc]) for (const x of ['provider.use']) expect(p.has(x)).toBe(true);
    for (const p of [pg, pgc]) for (const x of ['agent.plan', 'agent.act', 'project.read', 'files.read', 'terminal.use', 'agent.shell.run', 'mcp.use']) expect(p.has(x)).toBe(false);
    expect((await sqlDb().prepare("SELECT COUNT(*) c FROM roles WHERE builtin=1 AND name IN ('chat-general','chat-general-coding')").get()).c).toBe(2);
  });
  it('system prompts and skills are limited to the modes and tabs the role can use', async () => {
    const g = await login(app, { username: 'cg2', roles: ['chat-general'] });
    const gc = await login(app, { username: 'cgc2', roles: ['chat-general-coding'] });
    const dev = await login(app, { username: 'dev2', roles: ['developer'] });
    const p = await g.get('/api/profile/prompts');
    expect(p.body.kinds).toEqual(['general']); expect(Object.keys(p.body.defaults)).toEqual(['general']); expect(Object.keys(p.body.overrides)).toEqual(['general']);
    expect((await gc.get('/api/profile/prompts')).body.kinds).toEqual(['chat', 'general']);
    expect((await dev.get('/api/profile/prompts')).body.kinds).toEqual(['plan', 'act', 'chat', 'general']);
    for (const k of ['plan', 'act', 'chat']) expect((await g.put('/api/profile/prompts').send({ [k]: 'x' })).status, k).toBe(403);
    expect((await g.put('/api/profile/prompts').send({ general: 'mine' })).status).toBe(200);
    expect((await g.get('/api/profile/prompts')).body.overrides.general).toBe('mine');
    expect((await g.get('/api/skills')).status).toBe(403);
    expect((await g.post('/api/skills').send({ name: 'sneaky', instructions: 'x' })).status).toBe(403);
    expect((await g.get('/api/skills?scope=chat')).status).toBe(200);
    expect((await gc.get('/api/skills')).status).toBe(403);
    expect((await dev.get('/api/skills')).status).toBe(200);
  });
  it('built-in mcp-admin can manage tenant MCP servers and nothing else', async () => {
    const m = await login(app, { username: 'mcpadm', roles: ['mcp-admin'] });
    expect([...(await userPermissions(m.id))].sort()).toEqual(['mcp.read', 'mcp.write']);
    expect((await sqlDb().prepare("SELECT builtin FROM roles WHERE name='mcp-admin'").get())).toEqual({ builtin: 1 });
  });
  it('unions permissions across roles', async () => {
    await makeRole('r1', ['project.read']); await makeRole('r2', ['files.read']);
    const u = await login(app, { username: 'u', roles: ['r1', 'r2'] });
    expect([...(await userPermissions(u.id))].sort()).toEqual(['files.read', 'project.read']);
  });
  it('unauthenticated -> 401, missing permission -> 403, read-without-write is enforced', async () => {
    expect((await request(app).get('/api/projects')).status).toBe(401);
    await makeRole('readonly', ['project.read', 'files.read']);
    const u = await login(app, { username: 'ro', roles: ['readonly'] });
    expect((await u.get('/api/projects')).status).toBe(200);
    const w = await u.post('/api/projects').send({ name: 'x' });
    expect(w.status).toBe(403);
    expect(w.body.permission).toBe('project.write');
    expect((await u.get('/api/admin/users')).status).toBe(403);
  });
  it('custom roles are created via the admin API and validate permissions', async () => {
    const admin = await login(app, { username: 'adm', roles: ['administrator'] });
    const ok = await admin.post('/api/admin/roles').send({ name: 'Reviewer', permissions: ['project.read', 'files.read', 'agent.plan'] });
    expect(ok.status).toBe(201);
    expect((await admin.post('/api/admin/roles').send({ name: 'Bad', permissions: ['nope'] })).status).toBe(400);
    expect((await admin.post('/api/admin/roles').send({ name: 'Reviewer', permissions: [] })).status).toBe(409);
  });
  it('users cannot access other users\' projects (object-level check)', async () => {
    const a = await login(app, { username: 'alice' }), b = await login(app, { username: 'bobby' });
    const p = await a.post('/api/projects').send({ name: 'mine' });
    expect(p.status).toBe(201);
    expect((await b.get(`/api/projects/${p.body.id}/tree`)).status).toBe(404);
    expect((await a.get(`/api/projects/${p.body.id}/tree`)).status).toBe(200);
  });
  it('every registered route declares an access policy (deny by default)', () => {
    expect(registry.length).toBeGreaterThan(50);
    for (const r of registry) {
      const a = r.access;
      expect(a === 'public' || a === 'authenticated' || a === 'partial' || typeof a === 'string' || (a && typeof a.perm === 'string'), `${r.method} ${r.path}`).toBe(true);
      if (typeof a === 'string' && !['public', 'authenticated', 'partial'].includes(a)) expect(ALL_PERMISSIONS, `${r.method} ${r.path}`).toContain(a);
      if (a && typeof a === 'object') expect(ALL_PERMISSIONS).toContain(a.perm);
    }
    const publicRoutes = [...new Set(registry.filter((r) => r.access === 'public').map((r) => `${r.method} ${r.path}`))].sort();
    expect(publicRoutes).toEqual(['GET /api/public-config', 'GET /auth/saml/login', 'GET /auth/saml/metadata', 'POST /api/auth/local/login', 'POST /auth/saml/acs']);
  });
});
