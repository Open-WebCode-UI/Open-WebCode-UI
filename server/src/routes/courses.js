import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getKnex } from '../db/index.js';
import { trx, insertId } from '../db/dialect.js';
import { defineRoutes, fail, validate, z } from '../http.js';
import { audit } from '../audit.js';
import { userDto } from '../users.js';
import { getSettings, saveSettings, schemas } from '../settings.js';
import { createAdapter } from '../llm/provider.js';
import { runAgentTurn } from '../agent/loop.js';
import { resolveModel } from './providers.js';
import { allowedCourseModelIds, courseModelAllowed, effectiveCourseModelId } from '../courses/models.js';
import { sse, thinkingOf } from './agent.js';
import { loadMessages, persistFrom, touch as touchConversation } from '../sessions.js';
import { recordUsage } from '../usage.js';
import { courseSystemPrompt, fileNameOf } from '../courses/tutor.js';
import { removeSnapshots } from '../courses/exercises.js';
import { scopeOf, describePolicy, policySchema, deniedPermissions, effectivePermissions } from '../courses/policy.js';
import { getProject } from './projects.js';
import { ASSESSMENT_LAYOUT, createAssessmentPage, deleteAssessmentAndPage, assessmentOfPage } from '../courses/assessment-pages.js';
import { loadOutline, nextPosition, moduleBelongsTo, applyOutline, outlineItems } from '../courses/outline.js';
import { canAuthor, canLearn, canAdminCourses, listLearnerCourses } from '../courses/access.js';

const LAYOUTS = ['content', 'chat', 'agent', 'agent_file', 'assessment'];
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/; // one plain file name: no folders
const MAX_FILE = 200_000;
const json = z.record(z.string(), z.any()).refine((o) => JSON.stringify(o).length <= 1_000_000, 'too_large');
// Chat/tutor settings. Subpanel ids are checked against the admin catalog once that exists.
// Content for the subpanels an instructor turns on: hints (revealed one at a time) and resource links.
const subpanelContent = z.object({
  hints: z.array(z.string().trim().min(1).max(1000)).max(20).optional(),
  links: z.array(z.object({ title: z.string().trim().min(1).max(100), url: z.url().refine((u) => /^https?:\/\//i.test(u), 'must be http(s)') })).max(20).optional(),
}).strict();
const pageConfig = z.object({
  systemPrompt: z.string().max(8000).optional(),
  modelId: z.number().int().optional(),
  thinking: z.boolean().optional(),
  fileName: z.string().regex(FILE_NAME).optional(), // agent_file layout: the one file, and the text it starts with
  fileContent: z.string().max(MAX_FILE).optional(),
  subpanels: z.array(z.string().max(64)).max(20).optional(),
  subpanelContent: z.record(z.string().max(64), subpanelContent).optional(),
}).strict();
const courseBody = z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(5000).default('') });
const pageBody = z.object({
  moduleId: z.number().int().nullable().optional(),
  title: z.string().trim().min(1).max(200), layout: z.enum(LAYOUTS).default('content'),
  content: json.default({}), config: pageConfig.default({}),
});
const enrollBody = z.object({ type: z.enum(['user', 'role', 'saml_group']), id: z.union([z.string().min(1).max(200), z.number()]) });

const now = () => Math.floor(Date.now() / 1000);
const pageDto = async (p, { author }) => {
  const config = JSON.parse(p.config_json);
  if (!author) delete config.systemPrompt; // learners never see the tutor's instructions
  return { id: p.id, courseId: p.course_id, moduleId: p.module_id ?? null, position: p.position, title: p.title, layout: p.layout, content: JSON.parse(p.content_json), config,
    ...(p.layout === ASSESSMENT_LAYOUT ? { assessmentId: (await assessmentOfPage(p.id))?.id ?? null } : {}) };
};
const courseDto = (c) => ({ id: c.id, title: c.title, description: c.description, ownerId: c.owner_id, status: c.status, updatedAt: c.updated_at });

const intParam = (v) => { const n = Number(v); return Number.isInteger(n) ? n : null; };
export async function getCourse(req) {
  const id = intParam(req.params.id);
  const c = id === null ? null : await getKnex()('courses').where({ id }).first();
  if (!c) fail(404, 'course_not_found');
  return c;
}
// Authoring access; hides the course's existence from users who could not see it at all.
export async function authorCourse(req) {
  const c = await getCourse(req);
  if (!(await canAuthor(req.user.id, c))) {
    const learner = await canLearn(req.user.id, c);
    fail(learner ? 403 : 404, learner ? 'forbidden' : 'course_not_found');
  }
  return c;
}
async function getPage(req, courseId) {
  const id = intParam(req.params.pid);
  const p = id === null ? null : await getKnex()('course_pages').where({ id, course_id: courseId }).first();
  if (!p) fail(404, 'page_not_found');
  return p;
}
// Subpanels are the administrator's catalog; a page may only turn on ones that exist and are enabled, and only on a tutor page.
// The page's model must be one the instructor can use themselves.
// The administrator may also limit which models instructors can choose.
export const checkModelId = async (req, id) => {
  if (id == null) return;
  if (!courseModelAllowed(id)) fail(400, 'model_not_allowed');
  if (!await resolveModel(req.user, id)) fail(400, 'model_unavailable');
};
const checkModel = (req, b) => checkModelId(req, b.config.modelId);
function checkSubpanels(b) {
  const ids = b.config.subpanels || [];
  if (!ids.length && !b.config.subpanelContent) return;
  if (b.layout !== 'agent') fail(400, 'subpanels_need_agent_layout');
  const ok = new Set(getSettings('courses').subpanels.filter((x) => x.enabled).map((x) => x.id));
  for (const id of [...ids, ...Object.keys(b.config.subpanelContent || {})]) if (!ok.has(id)) fail(400, 'unknown_subpanel', { subpanel: id });
}
const touch = (id, t = getKnex()) => t('courses').where({ id }).update({ updated_at: now() });

export function coursesRouter({ adapterFactory } = {}) {
  const r = express.Router();
  const route = defineRoutes(r, '/api');
  const k = () => getKnex();
  const pageRow = (id) => k()('course_pages').where({ id }).first();

  // Courses the user can take (enrolled and published), with their progress.
  route.get('/courses', 'course.learn', async (req, res) => {
    const courses = await listLearnerCourses(req.user.id);
    res.json(await Promise.all(courses.map(async (c) => ({
      ...courseDto(c),
      pages: (await k()('course_pages').where({ course_id: c.id }).count({ n: '*' }).first()).n,
      completed: (await k()('course_progress').where({ course_id: c.id, user_id: req.user.id }).count({ n: '*' }).first()).n,
    }))));
  });
  // Courses the user can author (their own and co-instructed; all of them for course admins).
  route.get('/courses/authored', 'course.author', async (req, res) => {
    const all = await canAdminCourses(req.user.id);
    const rows = await k()('courses').modify((q) => {
      if (!all) q.where('owner_id', req.user.id).orWhereIn('id', k()('course_instructors').where({ user_id: req.user.id }).select('course_id'));
    }).orderBy('updated_at', 'desc');
    res.json(rows.map(courseDto));
  });
  route.post('/courses', 'course.author', async (req, res) => {
    const b = validate(courseBody, req.body);
    const id = await insertId(k()('courses'), { title: b.title, description: b.description, owner_id: req.user.id });
    await audit(req.user.id, 'course.create', String(id), { title: b.title });
    res.status(201).json(courseDto(await k()('courses').where({ id }).first()));
  });

  // One course with its pages: full for authors, published-and-enrolled only for learners.
  route.get('/courses/:id', 'authenticated', async (req, res) => {
    const c = await getCourse(req);
    const author = await canAuthor(req.user.id, c);
    if (!author && !(await canLearn(req.user.id, c))) fail(404, 'course_not_found');
    // `pages` is in reading order (the outline flattened); `outline` is the structure: top-level pages and modules with their page ids.
    const { pages: rows, outline } = await loadOutline(c.id);
    const pages = await Promise.all(rows.map((p) => pageDto(p, { author })));
    const completed = (await k()('course_progress').where({ course_id: c.id, user_id: req.user.id }).select('page_id')).map((x) => x.page_id);
    res.json({ ...courseDto(c), canEdit: author, pages, outline, completed, subpanels: getSettings('courses').subpanels.filter((x) => x.enabled) });
  });
  route.put('/courses/:id', 'course.author', async (req, res) => {
    const c = await authorCourse(req);
    const b = validate(courseBody.extend({ status: z.enum(['draft', 'published', 'archived']).optional() }), req.body);
    await k()('courses').where({ id: c.id }).update({ title: b.title, description: b.description, status: b.status ?? c.status, updated_at: now() });
    await audit(req.user.id, 'course.update', String(c.id), { status: b.status ?? c.status });
    res.json(courseDto(await k()('courses').where({ id: c.id }).first()));
  });
  route.delete('/courses/:id', 'course.author', async (req, res) => {
    const c = await authorCourse(req);
    removeSnapshots((await k()('attempts as att').join('assessments as a', 'a.id', 'att.assessment_id').where('a.course_id', c.id).select('att.id')).map((x) => x.id));
    await k()('courses').where({ id: c.id }).del();
    await audit(req.user.id, 'course.delete', String(c.id), { title: c.title });
    res.json({ ok: true });
  });

  // Pages
  route.post('/courses/:id/pages', 'course.author', async (req, res) => {
    const c = await authorCourse(req);
    const b = validate(pageBody, req.body); checkSubpanels(b); await checkModel(req, b);
    if (b.moduleId != null && !(await moduleBelongsTo(c.id, b.moduleId))) fail(404, 'module_not_found');
    if (b.layout === ASSESSMENT_LAYOUT) { // a new quiz: the page and its assessment (default settings, no questions yet)
      const { pageId } = await createAssessmentPage(c.id, { moduleId: b.moduleId ?? null, title: b.title, content: b.content });
      await touch(c.id);
      await audit(req.user.id, 'course.page.create', String(c.id), { page: pageId, layout: b.layout });
      return res.status(201).json(await pageDto(await pageRow(pageId), { author: true }));
    }
    const id = await trx(k(), async (t) => insertId(t('course_pages'), {
      course_id: c.id, module_id: b.moduleId ?? null, position: await nextPosition(c.id, b.moduleId ?? null, t), title: b.title, layout: b.layout, content_json: JSON.stringify(b.content), config_json: JSON.stringify(b.config),
    }));
    await touch(c.id);
    await audit(req.user.id, 'course.page.create', String(c.id), { page: id, layout: b.layout });
    res.status(201).json(await pageDto(await pageRow(id), { author: true }));
  });
  // Modules group pages. Moving pages between modules and reordering anything is one call: the whole outline.
  const moduleBody = z.object({ title: z.string().trim().min(1).max(200) });
  const getModule = async (req, courseId) => {
    const id = intParam(req.params.mid);
    const m = id === null ? null : await k()('course_modules').where({ id, course_id: courseId }).first();
    if (!m) fail(404, 'module_not_found');
    return m;
  };
  route.post('/courses/:id/modules', 'course.author', async (req, res) => {
    const c = await authorCourse(req);
    const b = validate(moduleBody, req.body);
    const id = await trx(k(), async (t) => insertId(t('course_modules'), { course_id: c.id, position: await nextPosition(c.id, null, t), title: b.title }));
    await touch(c.id);
    await audit(req.user.id, 'course.module.create', String(c.id), { module: id });
    res.status(201).json({ id, courseId: c.id, title: b.title });
  });
  route.put('/courses/:id/modules/:mid', 'course.author', async (req, res) => {
    const c = await authorCourse(req); const m = await getModule(req, c.id);
    const b = validate(moduleBody, req.body);
    await k()('course_modules').where({ id: m.id }).update({ title: b.title, updated_at: now() });
    await touch(c.id);
    await audit(req.user.id, 'course.module.update', String(c.id), { module: m.id });
    res.json({ id: m.id, courseId: c.id, title: b.title });
  });
  // Deleting a module keeps its pages: they move to the top level, where the module was.
  route.delete('/courses/:id/modules/:mid', 'course.author', async (req, res) => {
    const c = await authorCourse(req); const m = await getModule(req, c.id);
    const items = (await outlineItems(c.id)).flatMap((i) => (i.type === 'module' && i.id === m.id ? i.pages.map((id) => ({ type: 'page', id })) : [i]));
    await trx(k(), async (t) => { await t('course_pages').where({ module_id: m.id }).update({ module_id: null }); await t('course_modules').where({ id: m.id }).del(); });
    await applyOutline(c.id, items);
    await touch(c.id);
    await audit(req.user.id, 'course.module.delete', String(c.id), { module: m.id });
    res.json({ ok: true });
  });
  route.put('/courses/:id/outline', 'course.author', async (req, res) => {
    const c = await authorCourse(req);
    const item = z.discriminatedUnion('type', [z.object({ type: z.literal('page'), id: z.number().int() }), z.object({ type: z.literal('module'), id: z.number().int(), pages: z.array(z.number().int()).default([]) })]);
    const { items } = validate(z.object({ items: z.array(item).max(2000) }), req.body);
    if (!(await applyOutline(c.id, items))) fail(400, 'outline_mismatch');
    await touch(c.id);
    await audit(req.user.id, 'course.outline.update', String(c.id));
    res.json({ ok: true });
  });
  route.put('/courses/:id/pages/:pid', 'course.author', async (req, res) => {
    const c = await authorCourse(req); const p = await getPage(req, c.id);
    const b = validate(pageBody, req.body); checkSubpanels(b); await checkModel(req, b);
    if ((p.layout === ASSESSMENT_LAYOUT) !== (b.layout === ASSESSMENT_LAYOUT)) fail(400, 'layout_locked'); // a page is born an assessment, or never becomes one
    if (b.layout === ASSESSMENT_LAYOUT) b.config = {};
    if (b.moduleId !== undefined && b.moduleId !== p.module_id) { // moving the page: it goes to the end of the module (or of the top level)
      if (b.moduleId != null && !(await moduleBelongsTo(c.id, b.moduleId))) fail(404, 'module_not_found');
      const items = (await outlineItems(c.id)).map((i) => (i.type === 'module' ? { ...i, pages: i.pages.filter((x) => x !== p.id) } : i)).filter((i) => !(i.type === 'page' && i.id === p.id));
      if (b.moduleId == null) items.push({ type: 'page', id: p.id }); else items.find((i) => i.type === 'module' && i.id === b.moduleId).pages.push(p.id);
      await applyOutline(c.id, items);
    }
    await k()('course_pages').where({ id: p.id }).update({ title: b.title, layout: b.layout, content_json: JSON.stringify(b.content), config_json: JSON.stringify(b.config), updated_at: now() });
    if (b.layout === ASSESSMENT_LAYOUT) await k()('assessments').where({ page_id: p.id }).update({ title: b.title });
    await touch(c.id);
    await audit(req.user.id, 'course.page.update', String(c.id), { page: p.id });
    res.json(await pageDto(await pageRow(p.id), { author: true }));
  });
  route.delete('/courses/:id/pages/:pid', 'course.author', async (req, res) => {
    const c = await authorCourse(req); const p = await getPage(req, c.id);
    const quiz = p.layout === ASSESSMENT_LAYOUT ? await assessmentOfPage(p.id) : null;
    if (quiz) await deleteAssessmentAndPage(quiz); else await k()('course_pages').where({ id: p.id }).del();
    await touch(c.id);
    await audit(req.user.id, 'course.page.delete', String(c.id), { page: p.id });
    res.json({ ok: true });
  });

  // Learner progress
  route.post('/courses/:id/pages/:pid/complete', 'course.learn', async (req, res) => {
    const c = await getCourse(req);
    if (!(await canLearn(req.user.id, c))) fail(404, 'course_not_found');
    const p = await getPage(req, c.id);
    if (p.layout === ASSESSMENT_LAYOUT) fail(400, 'completes_by_assessment'); // finishing the assessment completes it
    await k()('course_progress').insert({ course_id: c.id, user_id: req.user.id, page_id: p.id }).onConflict(['user_id', 'page_id']).ignore();
    res.json({ ok: true });
  });

  // Enrollment. Users and roles: any author of the course. SAML groups: course admins only (they tie courses to IdP groups).
  route.get('/courses/:id/enrollments', 'course.author', async (req, res) => {
    const c = await authorCourse(req);
    const rows = await k()('course_enrollments').where({ course_id: c.id }).orderBy([{ column: 'subject_type' }, { column: 'subject_id' }]).select('subject_type as type', 'subject_id as id');
    const userIds = rows.filter((e) => e.type === 'user').map((e) => Number(e.id)).filter(Number.isInteger);
    const users = new Map((userIds.length ? await k()('users').whereIn('id', userIds).select('id', 'username', 'display_name') : []).map((u) => [String(u.id), u]));
    res.json(rows.map((e) => ({ ...e, username: users.get(e.id)?.username ?? null, displayName: users.get(e.id)?.display_name ?? null })));
  });
  const checkSubject = async (req, b) => {
    if (b.type === 'saml_group' && !(await canAdminCourses(req.user.id))) fail(403, 'forbidden', { permission: 'course.admin' });
    const id = String(b.id);
    if (b.type === 'user' && !(Number.isInteger(Number(id)) && await k()('users').where({ id: Number(id) }).first('id'))) fail(400, 'unknown_user');
    if (b.type === 'role' && !(await k()('roles').where({ name: id }).first('id'))) fail(400, 'unknown_role');
    return id;
  };
  route.post('/courses/:id/enrollments', 'course.author', async (req, res) => {
    const c = await authorCourse(req);
    const b = validate(enrollBody, req.body); const id = await checkSubject(req, b);
    await k()('course_enrollments').insert({ course_id: c.id, subject_type: b.type, subject_id: id, assigned_by: req.user.id }).onConflict(['course_id', 'subject_type', 'subject_id']).ignore();
    await audit(req.user.id, 'course.enroll', String(c.id), { type: b.type, id });
    res.status(201).json({ ok: true });
  });
  route.delete('/courses/:id/enrollments', 'course.author', async (req, res) => {
    const c = await authorCourse(req);
    const b = validate(enrollBody, req.body); const id = await checkSubject(req, b);
    await k()('course_enrollments').where({ course_id: c.id, subject_type: b.type, subject_id: id }).del();
    await audit(req.user.id, 'course.unenroll', String(c.id), { type: b.type, id });
    res.json({ ok: true });
  });

  // ---------- Page panels: learner notes, and the chat / tutor conversation for a page.
  const panelPage = async (req) => {
    const c = await getCourse(req);
    if (!(await canAuthor(req.user.id, c)) && !(await canLearn(req.user.id, c))) fail(404, 'course_not_found'); // authors may try their own panels in preview
    return { c, p: await getPage(req, c.id) };
  };
  route.get('/courses/:id/pages/:pid/notes', 'authenticated', async (req, res) => {
    const { p } = await panelPage(req);
    res.json({ text: (await k()('course_notes').where({ user_id: req.user.id, page_id: p.id }).first('text'))?.text ?? '' });
  });
  route.put('/courses/:id/pages/:pid/notes', 'authenticated', async (req, res) => {
    const { p } = await panelPage(req);
    const { text } = validate(z.object({ text: z.string().max(20000) }), req.body);
    await k()('course_notes').insert({ user_id: req.user.id, page_id: p.id, text, updated_at: now() }).onConflict(['user_id', 'page_id']).merge();
    res.json({ ok: true });
  });

  // The editor on an 'agent_file' page: each learner has their own copy of the file, starting from the instructor's text.
  const filePage = async (req) => { const r = await panelPage(req); if (r.p.layout !== 'agent_file') fail(400, 'page_has_no_file'); return r; };
  const fileDto = async (req, p) => {
    const cfg = JSON.parse(p.config_json);
    const mine = await k()('course_page_files').where({ user_id: req.user.id, page_id: p.id }).first('content');
    return { name: fileNameOf(cfg), content: mine ? mine.content : (cfg.fileContent ?? ''), modified: !!mine };
  };
  const saveFile = (req, p, content) => k()('course_page_files').insert({ user_id: req.user.id, page_id: p.id, content, updated_at: now() }).onConflict(['user_id', 'page_id']).merge();
  route.get('/courses/:id/pages/:pid/file', 'authenticated', async (req, res) => res.json(await fileDto(req, (await filePage(req)).p)));
  route.put('/courses/:id/pages/:pid/file', 'authenticated', async (req, res) => {
    const { p } = await filePage(req);
    await saveFile(req, p, validate(z.object({ content: z.string().max(MAX_FILE) }), req.body).content);
    res.json({ ok: true });
  });
  route.delete('/courses/:id/pages/:pid/file', 'authenticated', async (req, res) => { // back to the instructor's starting text
    const { p } = await filePage(req);
    await k()('course_page_files').where({ user_id: req.user.id, page_id: p.id }).del();
    res.json(await fileDto(req, p));
  });

  const MAX_USER_MESSAGES = 100; // per page and learner: keeps one conversation from growing (and costing) without bound
  const pageConversation = (req, c, p) => k()('conversations').where({ user_id: req.user.id, page_id: p.id, kind: 'course' }).orderBy('id', 'desc').first();
  route.get('/courses/:id/pages/:pid/conversation', 'authenticated', async (req, res) => {
    const { c, p } = await panelPage(req);
    const conv = await pageConversation(req, c, p);
    res.json(conv ? { conversationId: conv.id, messages: (await loadMessages(conv.id)).filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content)).map((m) => ({ role: m.role, content: m.content, ...(JSON.parse(p.config_json).thinking && m.thinking ? { thinking: m.thinking } : {}) })) } : { conversationId: null, messages: [] });
  });
  route.delete('/courses/:id/pages/:pid/conversation', 'authenticated', async (req, res) => {
    const { c, p } = await panelPage(req);
    const conv = await pageConversation(req, c, p);
    if (conv) await k()('conversations').where({ id: conv.id }).del();
    res.json({ ok: true });
  });
  // One tutor/chat turn, streamed as server-sent events. No tools, no workspace, no web search or memory; except on an 'agent_file' page,
  // where the assistant gets the file tools for that page's one file.
  route.post('/courses/:id/pages/:pid/turn', 'authenticated', async (req, res, next) => {
    try {
      const { c, p } = await panelPage(req);
      if (p.layout === 'content' || p.layout === ASSESSMENT_LAYOUT) fail(400, 'page_has_no_panel');
      const fileMode = p.layout === 'agent_file';
      const b = validate(z.object({ message: z.string().trim().min(1).max(4000), ...(fileMode ? { content: z.string().max(MAX_FILE).optional() } : {}) }), req.body);
      const cfg = JSON.parse(p.config_json);
      const rm = await resolveModel(req.user, effectiveCourseModelId(cfg.modelId) ?? getSettings('general').defaultModels.chat);
      if (!rm) fail(400, 'no_model_available');
      let conv = await pageConversation(req, c, p);
      const messages = conv ? await loadMessages(conv.id) : [];
      if (messages.filter((m) => m.role === 'user').length >= MAX_USER_MESSAGES) fail(429, 'conversation_limit');
      if (!conv) {
        const id = await insertId(k()('conversations'), { user_id: req.user.id, kind: 'course', title: b.message.slice(0, 80), course_id: c.id, page_id: p.id });
        conv = await k()('conversations').where({ id }).first();
      }
      const start = messages.length;
      messages.push({ role: 'user', content: b.message });
      const send = sse(res), abort = new AbortController();
      res.on('close', () => abort.abort());
      // Thinking is the instructor's choice per page. When it is off the model gets no thinking setting and any reasoning a
      // model streams on its own is dropped, so the answer is the first thing the learner sees.
      const thinking = !!cfg.thinking;
      const emit = (ev) => { if (thinking || ev.type !== 'thinking') send(ev); };
      // File mode: the agent works in a scratch folder that holds only this learner's copy of the file. Whatever it leaves there is saved back.
      let scratch = null, fileCtx = {};
      if (fileMode) {
        const name = fileNameOf(cfg);
        if (b.content != null) await saveFile(req, p, b.content); // what the learner has typed so far is what the agent sees
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'course-file-'));
        fs.writeFileSync(path.join(scratch, name), (await fileDto(req, p)).content);
        const pushFile = async () => { try { const content = fs.readFileSync(path.join(scratch, name), 'utf8').slice(0, MAX_FILE); await saveFile(req, p, content); emit({ type: 'file', content }); } catch { /* deleted or unreadable: keep the saved copy */ } };
        fileCtx = {
          agentMode: 'act', root: scratch, onlyFile: name, onChange: pushFile,
          permissions: new Set(['agent.act']), subagents: false, isSubagent: false,
          toolDeny: new Set(['delete_file', 'create_checkpoint', 'list_changes', 'switch_mode', 'propose_plan', 'ask_user', 'spawn_agent', 'use_skill', 'run_command']),
        };
      }
      try {
        emit({ type: 'start', conversationId: conv.id });
        await runAgentTurn({
          adapter: (adapterFactory || createAdapter)(rm.provider), model: rm.model.model_id,
          system: courseSystemPrompt({ course: c, page: p, personaName: getSettings('branding').personaName }), messages,
          ctx: { agentMode: 'chat', execMode: 'files_only', permissions: new Set(), userId: req.user.id, webSearch: null, memory: null, ...fileCtx },
          emit, signal: abort.signal, maxIterations: fileMode ? 20 : 1, maxTokens: rm.model.max_tokens, temperature: rm.model.temperature ?? undefined, thinking: thinkingOf(rm.model, thinking),
          onUsage: async (u) => await recordUsage({ userId: req.user.id, conversationId: conv.id, model: rm.model, provider: rm.provider, kind: 'course', ...u }),
        });
      } catch (e) { send({ type: 'error', message: 'The model request failed.' }); console.error('course turn error', e?.message); }
      finally { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); await persistFrom(conv.id, messages, start); await touchConversation(conv.id, { modelId: rm.model.id }); res.end(); }
    } catch (e) { if (res.headersSent) res.end(); else next(e); }
  });

  // ---------- Administration: the tutor subpanel catalog.
  route.get('/admin/course-settings', 'course.admin', (_req, res) => res.json(getSettings('courses')));
  route.put('/admin/course-settings', 'course.admin', async (req, res) => {
    // Fields left out keep their current value, so the panel and model editors can save independently.
    const saved = await saveSettings('courses', validate(schemas.courses, { ...getSettings('courses'), ...req.body }));
    await audit(req.user.id, 'settings.courses.update', null, { subpanels: saved.subpanels.filter((x) => x.enabled).map((x) => x.id), allowedModelIds: saved.allowedModelIds });
    res.json(saved);
  });

  // Which models an instructor may choose for a course: null = any they can use.
  route.get('/courses-allowed-models', 'course.author', (_req, res) => res.json({ allowed: allowedCourseModelIds() }));

  // ---------- Exercise rules
  // The rules for a workspace, for the IDE to show: null for an ordinary project.
  route.get('/projects/:id/exercise-policy', 'project.read', async (req, res) => {
    const p = await getProject(req); const sc = await scopeOf(p.id);
    res.json(sc ? { mode: sc.policy.mode, shell: sc.policy.shell, locked: sc.locked, submitted: sc.submitted, expired: sc.expired, deadline: sc.deadline, summary: describePolicy(sc.policy) } : null);
  });
  // What learners with a given role could do under a set of rules, for the exercise builder's preview.
  const RELEVANT = { 'agent.plan': 'Plan with the agent', 'agent.act': 'Let the agent change files', 'files.write': 'Edit files', 'agent.shell.run': 'Agent shell commands', 'terminal.use': 'Terminal', 'git.commit': 'Git commit', 'git.push': 'Git push', 'download.code': 'Download the project', 'checkpoint.write': 'Create and restore checkpoints', 'mcp.use': 'MCP tools', 'memory.use': 'Agent memory', 'websearch.use': 'Web search' };
  route.get('/courses-roles', 'course.author', async (_req, res) => res.json((await k()('roles').orderBy('name').select('name')).map((r) => r.name)));
  route.post('/courses-policy-preview', 'course.author', async (req, res) => {
    const b = validate(z.object({ policy: policySchema, role: z.string().max(100) }), req.body);
    const role = (await k()('roles').where({ name: b.role }).first('id')) || fail(400, 'unknown_role');
    const has = new Set((await k()('role_permissions').where({ role_id: role.id }).select('permission')).map((x) => x.permission));
    const eff = effectivePermissions(has, { denied: deniedPermissions(b.policy) });
    res.json({ summary: describePolicy(b.policy), abilities: Object.entries(RELEVANT).map(([perm, label]) => ({ label, role: has.has(perm), allowed: eff.has(perm) })) });
  });

  // Finds people to enroll or promote by name. Returns only what is needed to pick someone; at least two characters, ten results.
  route.get('/courses-users', 'course.author', async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json([]);
    const like = `%${q.replace(/[!%_]/g, (c) => `!${c}`)}%`; // '!' escapes: a backslash is itself special in MariaDB string literals
    const rows = await k()('users').where('disabled', 0).where((w) => w
      .whereRaw("lower(username) LIKE ? ESCAPE '!'", [like]).orWhereRaw("lower(email) LIKE ? ESCAPE '!'", [like]).orWhereRaw("lower(display_name) LIKE ? ESCAPE '!'", [like])
      .orWhereRaw("lower(first_name || ' ' || last_name) LIKE ? ESCAPE '!'", [like])).orderBy('id').limit(10);
    res.json(await Promise.all(rows.map(async (u) => ({ id: u.id, label: (await userDto(u)).displayName, username: u.username || u.email }))));
  });

  // ---------- Administration: instructors, and every course with its SAML-group assignments.
  route.get('/admin/instructors', 'course.admin', async (_req, res) => {
    const links = await k()('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id').where('r.name', 'instructor').select('ur.user_id', 'ur.source');
    const sources = new Map();
    for (const l of links) sources.set(l.user_id, [...(sources.get(l.user_id) ?? []), l.source]);
    const users = sources.size ? await k()('users').whereIn('id', [...sources.keys()]).orderBy('id') : [];
    res.json(await Promise.all(users.map(async (u) => ({ id: u.id, label: (await userDto(u)).displayName, username: u.username || u.email, viaSaml: sources.get(u.id).includes('saml'), manual: sources.get(u.id).includes('manual') }))));
  });
  // Designating an instructor only touches the manual 'instructor' role; roles the IdP grants stay as they are.
  route.put('/admin/instructors/:userId', { perm: 'course.admin', stepup: true }, async (req, res) => {
    const { instructor } = validate(z.object({ instructor: z.boolean() }), req.body);
    const uid = intParam(req.params.userId);
    const u = uid === null ? null : await k()('users').where({ id: uid }).first('id', 'username', 'email');
    const role = await k()('roles').where({ name: 'instructor' }).first('id');
    if (!u) fail(404, 'not_found');
    if (!role) fail(409, 'instructor_role_missing');
    if (instructor) await k()('user_roles').insert({ user_id: u.id, role_id: role.id, source: 'manual' }).onConflict(['user_id', 'role_id', 'source']).ignore();
    else await k()('user_roles').where({ user_id: u.id, role_id: role.id, source: 'manual' }).del();
    await audit(req.user.id, instructor ? 'course.instructor.add' : 'course.instructor.remove', u.username || u.email, {});
    res.json({ ok: true });
  });
  route.get('/admin/courses', 'course.admin', async (_req, res) => {
    const rows = await k()('courses as c').join('users as u', 'u.id', 'c.owner_id').orderBy('c.updated_at', 'desc').select('c.*', 'u.display_name', 'u.username', 'u.email');
    const groups = new Map();
    for (const g of await k()('course_enrollments').where({ subject_type: 'saml_group' }).orderBy('subject_id').select('course_id', 'subject_id')) groups.set(g.course_id, [...(groups.get(g.course_id) ?? []), g.subject_id]);
    res.json(rows.map((c) => ({ ...courseDto(c), owner: c.display_name || c.username || c.email, groups: groups.get(c.id) ?? [] })));
  });
  // Group names the IdP has sent or that map to roles, to pick from when assigning a course.
  route.get('/admin/course-groups', 'course.admin', async (_req, res) => {
    const names = new Set([...(await k()('user_saml_groups').distinct('group_value')), ...(await k()('group_role_map').distinct('group_value'))].map((r) => r.group_value));
    res.json([...names].sort());
  });

  return r;
}
