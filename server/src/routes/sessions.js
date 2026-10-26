import express from 'express';
import { getKnex } from '../db/index.js';
import { defineRoutes, fail, validate, z } from '../http.js';
import { getSettings } from '../settings.js';
import { audit } from '../audit.js';
import { getProject } from './projects.js';
import { systemPromptFor } from '../agent/prompts.js';
import { agentSkills } from '../skills.js';
import { sessionCosts } from '../usage.js';
import { removeConversationFiles } from '../attachments.js';
import { loadMessages, estimateTokens, contextInfo, buildTimeline, DEFAULT_CONTEXT_WINDOW, activeConversations } from '../sessions.js';

export function sessionsRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/api');
  const own = async (req) => (await getKnex()('conversations').where({ id: Number(req.params.id) || -1, user_id: req.user.id, kind: 'agent' }).first()) || fail(404, 'session_not_found');
  // The fixed prompt (instructions + skill list) counts toward the context window too, so it is included in every size shown.
  const overhead = async (req, mode) => systemPromptFor(mode === 'act' ? 'act' : 'plan', req.user[`prompt_${mode === 'act' ? 'act' : 'plan'}`], { skills: await agentSkills(req.user.id), personaName: getSettings('branding').personaName }).length;
  // Context window for a session: the model it last used, else the default Plan/Act model, else a conservative default.
  const windowSize = async (c) => {
    const d = getSettings('general').defaultModels;
    const size = async (id) => { if (!id) return null; const m = await getKnex()('models').where({ id }).first('auto_context', 'context_size'); return m && !m.auto_context ? m.context_size : null; };
    return (await size(c?.model_id)) || (await size(d.act ?? d.plan)) || DEFAULT_CONTEXT_WINDOW;
  };

  // The user's agent sessions for a project, most recently used first.
  route.get('/sessions', 'agent.plan', async (req, res) => {
    const p = await getProject({ params: { id: Number(req.query.projectId) }, user: req.user });
    const rows = await getKnex()('conversations').where({ user_id: req.user.id, project_id: p.id, kind: 'agent' }).orderBy([{ column: 'updated_at', order: 'desc' }, { column: 'id', order: 'desc' }]).limit(100)
      .select('id', 'title', 'created_at', 'updated_at', 'mode', 'model_id');
    const costs = await sessionCosts(rows.map((c) => c.id), req.permissions); // null unless the administrator turned cost display on for everyone or this user has spend.view
    res.json(await Promise.all(rows.map(async (c) => {
      const msgs = await loadMessages(c.id);
      return { ...(costs ? { cost: costs.get(c.id) ?? 0 } : {}), modelId: c.model_id, id: c.id, title: c.title, createdAt: c.created_at, updatedAt: c.updated_at, mode: c.mode, messages: msgs.length, running: activeConversations.has(c.id), context: contextInfo(estimateTokens(msgs, await overhead(req, c.mode)), await windowSize(c)) };
    })));
  });

  // Everything needed to show a session again and carry on: the rebuilt timeline, its mode, any plan awaiting approval, and its size.
  route.get('/sessions/:id', 'agent.plan', async (req, res) => {
    const k = getKnex(), c = await own(req);
    const rows = await k('messages').where({ conversation_id: c.id }).orderBy('id').select('id', 'role', 'content', 'archived', 'kind', 'rolled_back');
    const events = await k('checkpoint_events').where({ conversation_id: c.id }).orderBy('id').select('checkpoint_id', 'label', 'anchor_message_id');
    res.json({ id: c.id, projectId: c.project_id, title: c.title, mode: c.mode, modelId: c.model_id, webSearch: !!c.web_search, pendingPlan: c.plan || null, running: activeConversations.has(c.id),
      context: contextInfo(estimateTokens(await loadMessages(c.id), await overhead(req, c.mode)), await windowSize(c)), items: buildTimeline(rows, { pendingPlan: c.plan, events }) });
  });

  route.put('/sessions/:id', 'agent.plan', async (req, res) => {
    const c = await own(req), { title } = validate(z.object({ title: z.string().trim().min(1).max(120) }), req.body);
    await getKnex()('conversations').where({ id: c.id }).update({ title });
    res.json({ ok: true, title });
  });
  route.delete('/sessions/:id', 'agent.plan', async (req, res) => {
    const c = await own(req);
    if (activeConversations.has(c.id)) fail(409, 'session_busy');
    await removeConversationFiles(c.id);
    await getKnex()('conversations').where({ id: c.id }).del();
    await audit(req.user.id, 'session.delete', String(c.id));
    res.json({ ok: true });
  });
  // Delete several of a project's sessions at once: the listed ids, or all of them. Sessions with a turn running are kept and counted.
  route.post('/sessions/bulk-delete', 'agent.plan', async (req, res) => {
    const b = validate(z.object({ projectId: z.number().int(), ids: z.array(z.number().int()).max(500).optional(), all: z.boolean().optional() }), req.body);
    if (!b.all && !b.ids?.length) fail(400, 'nothing_selected');
    const p = await getProject({ params: { id: b.projectId }, user: req.user }), k = getKnex();
    const rows = (await k('conversations').where({ user_id: req.user.id, project_id: p.id, kind: 'agent' }).select('id')).map((c) => c.id);
    const wanted = b.all ? rows : rows.filter((id) => b.ids.includes(id));
    const ids = wanted.filter((id) => !activeConversations.has(id));
    for (const id of ids) { await removeConversationFiles(id); await k('conversations').where({ id }).del(); }
    await audit(req.user.id, 'session.bulk_delete', String(p.id), { count: ids.length });
    res.json({ ok: true, deleted: ids.length, deletedIds: ids, skipped: wanted.length - ids.length });
  });
  return r;
}
