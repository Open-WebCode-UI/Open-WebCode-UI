import express from 'express';
import { defineRoutes, fail, validate, z } from '../http.js';
import { audit } from '../audit.js';
import { userPermissions } from '../auth/rbac.js';
import { terminals } from '../terminal/manager.js';
import { shellEnabled } from '../terminal/ws.js';
import { getProject } from './projects.js';

export function terminalRouter({ manager = terminals } = {}) {
  const r = express.Router();
  const route = defineRoutes(r, '/api');
  const project = async (req, id) => await getProject({ params: { id }, user: req.user });

  // What the Terminal pane may do right now (no secrets: only booleans and session ids the caller owns).
  route.get('/terminal/status', 'authenticated', async (req, res) => {
    const perms = await userPermissions(req.user.id), p = await project(req, Number(req.query.projectId));
    const on = shellEnabled();
    const user = on && perms.has('terminal.use') ? manager.find(req.user.id, p.id, 'user') : null;
    const agent = on && (perms.has('agent.shell.run') || perms.has('terminal.use')) ? manager.find(req.user.id, p.id, 'agent') : null;
    res.json({ enabled: on, canUse: on && perms.has('terminal.use'), canView: on && (perms.has('agent.shell.run') || perms.has('terminal.use')), userSession: user?.id ?? null, agentSession: agent?.id ?? null });
  });

  // Starting a shell on the server host is as sensitive as enabling shell mode, so it needs recent re-verification.
  route.post('/terminal/sessions', { perm: 'terminal.use', stepup: true }, async (req, res) => {
    if (!shellEnabled()) fail(403, 'shell_disabled', { message: 'The administrator has not enabled shell access.' });
    const b = validate(z.object({ projectId: z.number().int(), cols: z.number().int().min(20).max(400).default(100), rows: z.number().int().min(5).max(200).default(28) }), req.body);
    const p = await project(req, b.projectId);
    let s; const fresh = !manager.find(req.user.id, p.id, 'user');
    try { s = await manager.create({ userId: req.user.id, projectId: p.id, kind: 'user', cwd: p.dir, cols: b.cols, rows: b.rows }); }
    catch (e) { if (e.status === 429) fail(429, 'too_many_terminals'); throw e; }
    if (fresh) await audit(req.user.id, 'terminal.open', p.name); // reopening an existing session is not a new shell
    res.status(201).json({ id: s.id });
  });
  route.delete('/terminal/sessions/:id', 'terminal.use', async (req, res) => {
    const s = manager.get(req.params.id);
    if (!s || s.userId !== req.user.id || s.kind !== 'user') fail(404, 'not_found');
    manager.close(s.id); await audit(req.user.id, 'terminal.close', String(s.projectId));
    res.json({ ok: true });
  });
  return r;
}
