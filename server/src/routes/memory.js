import express from 'express';
import { getKnex } from '../db/index.js';
import { defineRoutes, fail, validate, z } from '../http.js';
import { audit } from '../audit.js';
import { getProject } from './projects.js';
import { memoryAllowed, userMemoryOn, projectMemoryOn, listEntries, addEntry, updateEntry, deleteEntry, clearEntries, MAX_TEXT } from '../memory.js';

export function memoryRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/api');
  const projectOf = async (req, id) => (id == null ? null : await getProject({ params: { id: Number(id) }, user: req.user }));

  // Everything the user can see about memory: the tenant switch, their own switch, and notes, and (with ?projectId=) that project's.
  route.get('/memory', 'memory.use', async (req, res) => {
    const p = await projectOf(req, req.query.projectId);
    res.json({
      allowed: memoryAllowed(), maxText: MAX_TEXT,
      user: { enabled: await userMemoryOn(req.user.id), entries: await listEntries(req.user.id, null) },
      ...(p ? { project: { id: p.id, name: p.name, enabled: await projectMemoryOn(p.id), entries: await listEntries(req.user.id, p.id) } } : {}),
    });
  });
  route.put('/memory/settings', 'memory.use', async (req, res) => {
    const b = validate(z.object({ scope: z.enum(['user', 'project']), projectId: z.number().int().optional(), enabled: z.boolean() }), req.body);
    if (b.scope === 'user') await getKnex()('users').where({ id: req.user.id }).update({ memory_enabled: +b.enabled });
    else { const p = await projectOf(req, b.projectId ?? fail(400, 'project_required')); await getKnex()('projects').where({ id: p.id }).update({ memory_enabled: +b.enabled }); }
    audit(req.user.id, 'memory.toggle', b.scope, { enabled: b.enabled, projectId: b.projectId });
    res.json({ ok: true });
  });
  route.post('/memory/entries', 'memory.use', async (req, res) => {
    const b = validate(z.object({ scope: z.enum(['user', 'project']), projectId: z.number().int().optional(), text: z.string().max(5000) }), req.body);
    const p = b.scope === 'project' ? await projectOf(req, b.projectId ?? fail(400, 'project_required')) : null;
    const e = await addEntry(req.user.id, p ? p.id : null, b.text, 'user');
    audit(req.user.id, 'memory.add', b.scope, { projectId: p?.id });
    res.status(201).json(e);
  });
  route.put('/memory/entries/:id', 'memory.use', async (req, res) => {
    const { text } = validate(z.object({ text: z.string().max(5000) }), req.body);
    const t = await updateEntry(req.user.id, Number(req.params.id), text);
    audit(req.user.id, 'memory.edit', req.params.id);
    res.json({ ok: true, text: t });
  });
  route.delete('/memory/entries/:id', 'memory.use', async (req, res) => {
    if (!await deleteEntry(req.user.id, Number(req.params.id))) fail(404, 'not_found');
    audit(req.user.id, 'memory.delete', req.params.id);
    res.json({ ok: true });
  });
  // Clear everything in one scope.
  route.delete('/memory', 'memory.use', async (req, res) => {
    const { scope } = validate(z.object({ scope: z.enum(['user', 'project']) }), req.query);
    const p = scope === 'project' ? await projectOf(req, req.query.projectId ?? fail(400, 'project_required')) : null;
    const n = await clearEntries(req.user.id, p ? p.id : null);
    audit(req.user.id, 'memory.clear', scope, { projectId: p?.id, removed: n });
    res.json({ ok: true, removed: n });
  });
  return r;
}
