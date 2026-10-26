import express from 'express';
import { defineRoutes, fail, validate, z } from '../http.js';
import { audit } from '../audit.js';
import { userPermissions } from '../auth/rbac.js';
import { listSkills, saveCustomSkill, saveBuiltinOverride, resetBuiltin, deleteCustom, SCOPES } from '../skills.js';

// Agent skills need the agent; chat skills need either chat tab. Without that access the scope is neither listed nor editable.
const SCOPE_ACCESS = { agent: ['agent.plan'], chat: ['chat.use', 'chat.general.use', 'chat.course.use'] };
const scopeOf = async (req) => {
  const scope = z.enum(SCOPES).default('agent').parse(req.query.scope || req.body?.scope);
  const perms = req.permissions || await userPermissions(req.user.id);
  if (!SCOPE_ACCESS[scope].some((p) => perms.has(p))) fail(403, 'forbidden', { permission: SCOPE_ACCESS[scope][0] });
  return scope;
};
const body = z.object({ scope: z.enum(SCOPES).optional(),  name: z.string().max(60), description: z.string().max(300).default(''), instructions: z.string().min(1).max(30000), enabled: z.boolean().default(true) });

export function skillsRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/api');

  // Skills are per-user (profile) and kept separately for the Agent page and the Chat page (?scope=agent|chat, default agent).
  // Listing is open to any signed-in user; editing needs profile.skills.edit.
  route.get('/skills', 'authenticated', async (req, res) => res.json(await listSkills(req.user.id, await scopeOf(req))));
  route.post('/skills', 'profile.skills.edit', async (req, res) => {
    const b = validate(body, req.body);
    const id = await saveCustomSkill(req.user.id, b, await scopeOf(req));
    await audit(req.user.id, 'skill.create', b.name);
    res.status(201).json({ id });
  });
  route.put('/skills/custom/:id', 'profile.skills.edit', async (req, res) => {
    const b = validate(body, req.body);
    await saveCustomSkill(req.user.id, { ...b, id: Number(req.params.id) }, await scopeOf(req));
    await audit(req.user.id, 'skill.update', b.name);
    res.json({ ok: true });
  });
  route.delete('/skills/custom/:id', 'profile.skills.edit', async (req, res) => {
    if (!await deleteCustom(req.user.id, Number(req.params.id), await scopeOf(req))) fail(404, 'not_found');
    await audit(req.user.id, 'skill.delete', req.params.id);
    res.json({ ok: true });
  });
  route.put('/skills/builtin/:key', 'profile.skills.edit', async (req, res) => {
    const b = validate(z.object({ scope: z.enum(SCOPES).optional(), description: z.string().max(300).optional(), instructions: z.string().min(1).max(30000).optional(), enabled: z.boolean().optional() }), req.body);
    await saveBuiltinOverride(req.user.id, req.params.key, b, await scopeOf(req));
    await audit(req.user.id, 'skill.builtin.update', req.params.key);
    res.json({ ok: true });
  });
  route.delete('/skills/builtin/:key', 'profile.skills.edit', async (req, res) => {
    await resetBuiltin(req.user.id, req.params.key, await scopeOf(req));
    await audit(req.user.id, 'skill.builtin.reset', req.params.key);
    res.json({ ok: true });
  });
  return r;
}
