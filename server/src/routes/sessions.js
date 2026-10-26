import express from 'express';
import { getDb } from '../db/index.js';
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
  const own = (req) => getDb().prepare("SELECT * FROM conversations WHERE id=? AND user_id=? AND kind='agent'").get(req.params.id, req.user.id) || fail(404, 'session_not_found');
  // The fixed prompt (instructions + skill list) counts toward the context window too, so it is included in every size shown.
  const overhead = async (req, mode) => systemPromptFor(mode === 'act' ? 'act' : 'plan', req.user[`prompt_${mode === 'act' ? 'act' : 'plan'}`], { skills: await agentSkills(req.user.id), personaName: getSettings('branding').personaName }).length;
  // Context window for a session: the model it last used, else the default Plan/Act model, else a conservative default.
  const windowSize = (c) => {
    const d = getSettings('general').defaultModels, db = getDb();
    const size = (id) => (id ? db.prepare('SELECT CASE WHEN auto_context THEN NULL ELSE context_size END c FROM models WHERE id=?').get(id)?.c : null);
    return size(c?.model_id) || size(d.act ?? d.plan) || DEFAULT_CONTEXT_WINDOW;
  };

  // The user's agent sessions for a project, most recently used first.
  route.get('/sessions', 'agent.plan', async (req, res) => {
    const p = await getProject({ params: { id: Number(req.query.projectId) }, user: req.user });
    const rows = getDb().prepare("SELECT id, title, created_at, updated_at, mode, model_id FROM conversations WHERE user_id=? AND project_id=? AND kind='agent' ORDER BY updated_at DESC, id DESC LIMIT 100").all(req.user.id, p.id);
    const costs = sessionCosts(rows.map((c) => c.id), req.permissions); // null unless the administrator turned cost display on for everyone or this user has spend.view
    res.json(await Promise.all(rows.map(async (c) => {
      const msgs = await loadMessages(c.id);
      return { ...(costs ? { cost: costs.get(c.id) ?? 0 } : {}), modelId: c.model_id, id: c.id, title: c.title, createdAt: c.created_at, updatedAt: c.updated_at, mode: c.mode, messages: msgs.length, running: activeConversations.has(c.id), context: contextInfo(estimateTokens(msgs, await overhead(req, c.mode)), windowSize(c)) };
    })));
  });

  // Everything needed to show a session again and carry on: the rebuilt timeline, its mode, any plan awaiting approval, and its size.
  route.get('/sessions/:id', 'agent.plan', async (req, res) => {
    const c = own(req), rows = getDb().prepare('SELECT id, role, content, archived, kind, rolled_back FROM messages WHERE conversation_id=? ORDER BY id').all(c.id), events = getDb().prepare('SELECT checkpoint_id, label, anchor_message_id FROM checkpoint_events WHERE conversation_id=? ORDER BY id').all(c.id);
    res.json({ id: c.id, projectId: c.project_id, title: c.title, mode: c.mode, modelId: c.model_id, webSearch: !!c.web_search, pendingPlan: c.plan || null, running: activeConversations.has(c.id),
      context: contextInfo(estimateTokens(await loadMessages(c.id), await overhead(req, c.mode)), windowSize(c)), items: buildTimeline(rows, { pendingPlan: c.plan, events }) });
  });

  route.put('/sessions/:id', 'agent.plan', (req, res) => {
    const c = own(req), { title } = validate(z.object({ title: z.string().trim().min(1).max(120) }), req.body);
    getDb().prepare('UPDATE conversations SET title=? WHERE id=?').run(title, c.id);
    res.json({ ok: true, title });
  });
  route.delete('/sessions/:id', 'agent.plan', (req, res) => {
    const c = own(req);
    if (activeConversations.has(c.id)) fail(409, 'session_busy');
    removeConversationFiles(c.id);
    getDb().prepare('DELETE FROM conversations WHERE id=?').run(c.id);
    audit(req.user.id, 'session.delete', String(c.id));
    res.json({ ok: true });
  });
  // Delete several of a project's sessions at once: the listed ids, or all of them. Sessions with a turn running are kept and counted.
  route.post('/sessions/bulk-delete', 'agent.plan', async (req, res) => {
    const b = validate(z.object({ projectId: z.number().int(), ids: z.array(z.number().int()).max(500).optional(), all: z.boolean().optional() }), req.body);
    if (!b.all && !b.ids?.length) fail(400, 'nothing_selected');
    const p = await getProject({ params: { id: b.projectId }, user: req.user }), db = getDb();
    const rows = db.prepare("SELECT id FROM conversations WHERE user_id=? AND project_id=? AND kind='agent'").all(req.user.id, p.id).map((c) => c.id);
    const wanted = b.all ? rows : rows.filter((id) => b.ids.includes(id));
    const ids = wanted.filter((id) => !activeConversations.has(id));
    for (const id of ids) { removeConversationFiles(id); db.prepare('DELETE FROM conversations WHERE id=?').run(id); }
    audit(req.user.id, 'session.bulk_delete', String(p.id), { count: ids.length });
    res.json({ ok: true, deleted: ids.length, deletedIds: ids, skipped: wanted.length - ids.length });
  });
  return r;
}
