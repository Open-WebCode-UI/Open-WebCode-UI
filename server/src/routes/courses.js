import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../db/index.js';
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
const pageDto = (p, { author }) => {
  const config = JSON.parse(p.config_json);
  if (!author) delete config.systemPrompt; // learners never see the tutor's instructions
  return { id: p.id, courseId: p.course_id, moduleId: p.module_id ?? null, position: p.position, title: p.title, layout: p.layout, content: JSON.parse(p.content_json), config,
    ...(p.layout === ASSESSMENT_LAYOUT ? { assessmentId: assessmentOfPage(p.id)?.id ?? null } : {}) };
};
const courseDto = (c) => ({ id: c.id, title: c.title, description: c.description, ownerId: c.owner_id, status: c.status, updatedAt: c.updated_at });

export function getCourse(req) {
  const c = getDb().prepare('SELECT * FROM courses WHERE id=?').get(req.params.id);
  if (!c) fail(404, 'course_not_found');
  return c;
}
// Authoring access; hides the course's existence from users who could not see it at all.
export function authorCourse(req) {
  const c = getCourse(req);
  if (!canAuthor(req.user.id, c)) fail(canLearn(req.user.id, c) ? 403 : 404, canLearn(req.user.id, c) ? 'forbidden' : 'course_not_found');
  return c;
}
function getPage(req, courseId) {
  const p = getDb().prepare('SELECT * FROM course_pages WHERE id=? AND course_id=?').get(req.params.pid, courseId);
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
const touch = (id) => getDb().prepare('UPDATE courses SET updated_at=? WHERE id=?').run(now(), id);

export function coursesRouter({ adapterFactory } = {}) {
  const r = express.Router();
  const route = defineRoutes(r, '/api');
  const db = () => getDb();

  // Courses the user can take (enrolled and published), with their progress.
  route.get('/courses', 'course.learn', (req, res) => {
    const done = db().prepare('SELECT COUNT(*) n FROM course_progress WHERE course_id=? AND user_id=?');
    const total = db().prepare('SELECT COUNT(*) n FROM course_pages WHERE course_id=?');
    res.json(listLearnerCourses(req.user.id).map((c) => ({ ...courseDto(c), pages: total.get(c.id).n, completed: done.get(c.id, req.user.id).n })));
  });
  // Courses the user can author (their own and co-instructed; all of them for course admins).
  route.get('/courses/authored', 'course.author', (req, res) => {
    const rows = canAdminCourses(req.user.id)
      ? db().prepare('SELECT * FROM courses ORDER BY updated_at DESC').all()
      : db().prepare(`SELECT * FROM courses WHERE owner_id=? OR id IN (SELECT course_id FROM course_instructors WHERE user_id=?)
          ORDER BY updated_at DESC`).all(req.user.id, req.user.id);
    res.json(rows.map(courseDto));
  });
  route.post('/courses', 'course.author', (req, res) => {
    const b = validate(courseBody, req.body);
    const id = Number(db().prepare('INSERT INTO courses (title, description, owner_id) VALUES (?,?,?)').run(b.title, b.description, req.user.id).lastInsertRowid);
    audit(req.user.id, 'course.create', String(id), { title: b.title });
    res.status(201).json(courseDto(db().prepare('SELECT * FROM courses WHERE id=?').get(id)));
  });

  // One course with its pages: full for authors, published-and-enrolled only for learners.
  route.get('/courses/:id', 'authenticated', (req, res) => {
    const c = getCourse(req);
    const author = canAuthor(req.user.id, c);
    if (!author && !canLearn(req.user.id, c)) fail(404, 'course_not_found');
    // `pages` is in reading order (the outline flattened); `outline` is the structure: top-level pages and modules with their page ids.
    const { pages: rows, outline } = loadOutline(c.id);
    const pages = rows.map((p) => pageDto(p, { author }));
    const completed = db().prepare('SELECT page_id FROM course_progress WHERE course_id=? AND user_id=?').all(c.id, req.user.id).map((x) => x.page_id);
    res.json({ ...courseDto(c), canEdit: author, pages, outline, completed, subpanels: getSettings('courses').subpanels.filter((x) => x.enabled) });
  });
  route.put('/courses/:id', 'course.author', (req, res) => {
    const c = authorCourse(req);
    const b = validate(courseBody.extend({ status: z.enum(['draft', 'published', 'archived']).optional() }), req.body);
    db().prepare('UPDATE courses SET title=?, description=?, status=?, updated_at=? WHERE id=?').run(b.title, b.description, b.status ?? c.status, now(), c.id);
    audit(req.user.id, 'course.update', String(c.id), { status: b.status ?? c.status });
    res.json(courseDto(db().prepare('SELECT * FROM courses WHERE id=?').get(c.id)));
  });
  route.delete('/courses/:id', 'course.author', (req, res) => {
    const c = authorCourse(req);
    removeSnapshots(db().prepare('SELECT att.id FROM attempts att JOIN assessments a ON a.id=att.assessment_id WHERE a.course_id=?').all(c.id).map((x) => x.id));
    db().prepare('DELETE FROM courses WHERE id=?').run(c.id);
    audit(req.user.id, 'course.delete', String(c.id), { title: c.title });
    res.json({ ok: true });
  });

  // Pages
  route.post('/courses/:id/pages', 'course.author', async (req, res) => {
    const c = authorCourse(req);
    const b = validate(pageBody, req.body); checkSubpanels(b); await checkModel(req, b);
    if (b.moduleId != null && !moduleBelongsTo(c.id, b.moduleId)) fail(404, 'module_not_found');
    if (b.layout === ASSESSMENT_LAYOUT) { // a new quiz: the page and its assessment (default settings, no questions yet)
      const { pageId } = createAssessmentPage(c.id, { moduleId: b.moduleId ?? null, title: b.title, content: b.content });
      touch(c.id);
      audit(req.user.id, 'course.page.create', String(c.id), { page: pageId, layout: b.layout });
      return res.status(201).json(pageDto(db().prepare('SELECT * FROM course_pages WHERE id=?').get(pageId), { author: true }));
    }
    const pos = nextPosition(c.id, b.moduleId ?? null);
    const id = Number(db().prepare('INSERT INTO course_pages (course_id, module_id, position, title, layout, content_json, config_json) VALUES (?,?,?,?,?,?,?)')
      .run(c.id, b.moduleId ?? null, pos, b.title, b.layout, JSON.stringify(b.content), JSON.stringify(b.config)).lastInsertRowid);
    touch(c.id);
    audit(req.user.id, 'course.page.create', String(c.id), { page: id, layout: b.layout });
    res.status(201).json(pageDto(db().prepare('SELECT * FROM course_pages WHERE id=?').get(id), { author: true }));
  });
  // Modules group pages. Moving pages between modules and reordering anything is one call: the whole outline.
  const moduleBody = z.object({ title: z.string().trim().min(1).max(200) });
  const getModule = (req, courseId) => {
    const m = db().prepare('SELECT * FROM course_modules WHERE id=? AND course_id=?').get(req.params.mid, courseId);
    if (!m) fail(404, 'module_not_found');
    return m;
  };
  route.post('/courses/:id/modules', 'course.author', (req, res) => {
    const c = authorCourse(req);
    const b = validate(moduleBody, req.body);
    const id = Number(db().prepare('INSERT INTO course_modules (course_id, position, title) VALUES (?,?,?)').run(c.id, nextPosition(c.id), b.title).lastInsertRowid);
    touch(c.id);
    audit(req.user.id, 'course.module.create', String(c.id), { module: id });
    res.status(201).json({ id, courseId: c.id, title: b.title });
  });
  route.put('/courses/:id/modules/:mid', 'course.author', (req, res) => {
    const c = authorCourse(req); const m = getModule(req, c.id);
    const b = validate(moduleBody, req.body);
    db().prepare('UPDATE course_modules SET title=?, updated_at=? WHERE id=?').run(b.title, now(), m.id);
    touch(c.id);
    audit(req.user.id, 'course.module.update', String(c.id), { module: m.id });
    res.json({ id: m.id, courseId: c.id, title: b.title });
  });
  // Deleting a module keeps its pages: they move to the top level, where the module was.
  route.delete('/courses/:id/modules/:mid', 'course.author', (req, res) => {
    const c = authorCourse(req); const m = getModule(req, c.id);
    const items = outlineItems(c.id).flatMap((i) => (i.type === 'module' && i.id === m.id ? i.pages.map((id) => ({ type: 'page', id })) : [i]));
    db().transaction(() => { db().prepare('UPDATE course_pages SET module_id=NULL WHERE module_id=?').run(m.id); db().prepare('DELETE FROM course_modules WHERE id=?').run(m.id); applyOutline(c.id, items); })();
    touch(c.id);
    audit(req.user.id, 'course.module.delete', String(c.id), { module: m.id });
    res.json({ ok: true });
  });
  route.put('/courses/:id/outline', 'course.author', (req, res) => {
    const c = authorCourse(req);
    const item = z.discriminatedUnion('type', [z.object({ type: z.literal('page'), id: z.number().int() }), z.object({ type: z.literal('module'), id: z.number().int(), pages: z.array(z.number().int()).default([]) })]);
    const { items } = validate(z.object({ items: z.array(item).max(2000) }), req.body);
    if (!applyOutline(c.id, items)) fail(400, 'outline_mismatch');
    touch(c.id);
    audit(req.user.id, 'course.outline.update', String(c.id));
    res.json({ ok: true });
  });
  route.put('/courses/:id/pages/:pid', 'course.author', async (req, res) => {
    const c = authorCourse(req); const p = getPage(req, c.id);
    const b = validate(pageBody, req.body); checkSubpanels(b); await checkModel(req, b);
    if ((p.layout === ASSESSMENT_LAYOUT) !== (b.layout === ASSESSMENT_LAYOUT)) fail(400, 'layout_locked'); // a page is born an assessment, or never becomes one
    if (b.layout === ASSESSMENT_LAYOUT) b.config = {};
    if (b.moduleId !== undefined && b.moduleId !== p.module_id) { // moving the page: it goes to the end of the module (or of the top level)
      if (b.moduleId != null && !moduleBelongsTo(c.id, b.moduleId)) fail(404, 'module_not_found');
      const items = outlineItems(c.id).map((i) => (i.type === 'module' ? { ...i, pages: i.pages.filter((x) => x !== p.id) } : i)).filter((i) => !(i.type === 'page' && i.id === p.id));
      if (b.moduleId == null) items.push({ type: 'page', id: p.id }); else items.find((i) => i.type === 'module' && i.id === b.moduleId).pages.push(p.id);
      applyOutline(c.id, items);
    }
    db().prepare('UPDATE course_pages SET title=?, layout=?, content_json=?, config_json=?, updated_at=? WHERE id=?')
      .run(b.title, b.layout, JSON.stringify(b.content), JSON.stringify(b.config), now(), p.id);
    if (b.layout === ASSESSMENT_LAYOUT) db().prepare('UPDATE assessments SET title=? WHERE page_id=?').run(b.title, p.id);
    touch(c.id);
    audit(req.user.id, 'course.page.update', String(c.id), { page: p.id });
    res.json(pageDto(db().prepare('SELECT * FROM course_pages WHERE id=?').get(p.id), { author: true }));
  });
  route.delete('/courses/:id/pages/:pid', 'course.author', (req, res) => {
    const c = authorCourse(req); const p = getPage(req, c.id);
    const quiz = p.layout === ASSESSMENT_LAYOUT ? assessmentOfPage(p.id) : null;
    if (quiz) deleteAssessmentAndPage(quiz); else db().prepare('DELETE FROM course_pages WHERE id=?').run(p.id);
    touch(c.id);
    audit(req.user.id, 'course.page.delete', String(c.id), { page: p.id });
    res.json({ ok: true });
  });

  // Learner progress
  route.post('/courses/:id/pages/:pid/complete', 'course.learn', (req, res) => {
    const c = getCourse(req);
    if (!canLearn(req.user.id, c)) fail(404, 'course_not_found');
    const p = getPage(req, c.id);
    if (p.layout === ASSESSMENT_LAYOUT) fail(400, 'completes_by_assessment'); // finishing the assessment completes it
    db().prepare('INSERT OR IGNORE INTO course_progress (course_id, user_id, page_id) VALUES (?,?,?)').run(c.id, req.user.id, p.id);
    res.json({ ok: true });
  });

  // Enrollment. Users and roles: any author of the course. SAML groups: course admins only (they tie courses to IdP groups).
  route.get('/courses/:id/enrollments', 'course.author', (req, res) => {
    const c = authorCourse(req);
    const rows = db().prepare(`SELECT e.subject_type type, e.subject_id id, u.username, u.display_name displayName
      FROM course_enrollments e LEFT JOIN users u ON e.subject_type='user' AND u.id=CAST(e.subject_id AS INTEGER)
      WHERE e.course_id=? ORDER BY e.subject_type, e.subject_id`).all(c.id);
    res.json(rows);
  });
  const checkSubject = (req, b) => {
    if (b.type === 'saml_group' && !canAdminCourses(req.user.id)) fail(403, 'forbidden', { permission: 'course.admin' });
    const id = String(b.id);
    if (b.type === 'user' && !db().prepare('SELECT 1 FROM users WHERE id=?').get(Number(id))) fail(400, 'unknown_user');
    if (b.type === 'role' && !db().prepare('SELECT 1 FROM roles WHERE name=?').get(id)) fail(400, 'unknown_role');
    return id;
  };
  route.post('/courses/:id/enrollments', 'course.author', (req, res) => {
    const c = authorCourse(req);
    const b = validate(enrollBody, req.body); const id = checkSubject(req, b);
    db().prepare('INSERT OR IGNORE INTO course_enrollments (course_id, subject_type, subject_id, assigned_by) VALUES (?,?,?,?)').run(c.id, b.type, id, req.user.id);
    audit(req.user.id, 'course.enroll', String(c.id), { type: b.type, id });
    res.status(201).json({ ok: true });
  });
  route.delete('/courses/:id/enrollments', 'course.author', (req, res) => {
    const c = authorCourse(req);
    const b = validate(enrollBody, req.body); const id = checkSubject(req, b);
    db().prepare('DELETE FROM course_enrollments WHERE course_id=? AND subject_type=? AND subject_id=?').run(c.id, b.type, id);
    audit(req.user.id, 'course.unenroll', String(c.id), { type: b.type, id });
    res.json({ ok: true });
  });

  // ---------- Page panels: learner notes, and the chat / tutor conversation for a page.
  const panelPage = (req) => {
    const c = getCourse(req);
    if (!canAuthor(req.user.id, c) && !canLearn(req.user.id, c)) fail(404, 'course_not_found'); // authors may try their own panels in preview
    return { c, p: getPage(req, c.id) };
  };
  route.get('/courses/:id/pages/:pid/notes', 'authenticated', (req, res) => {
    const { p } = panelPage(req);
    res.json({ text: db().prepare('SELECT text FROM course_notes WHERE user_id=? AND page_id=?').get(req.user.id, p.id)?.text ?? '' });
  });
  route.put('/courses/:id/pages/:pid/notes', 'authenticated', (req, res) => {
    const { p } = panelPage(req);
    const { text } = validate(z.object({ text: z.string().max(20000) }), req.body);
    db().prepare(`INSERT INTO course_notes (user_id, page_id, text, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id, page_id) DO UPDATE SET text=excluded.text, updated_at=excluded.updated_at`).run(req.user.id, p.id, text, now());
    res.json({ ok: true });
  });

  // The editor on an 'agent_file' page: each learner has their own copy of the file, starting from the instructor's text.
  const filePage = (req) => { const r = panelPage(req); if (r.p.layout !== 'agent_file') fail(400, 'page_has_no_file'); return r; };
  const fileDto = (req, p) => {
    const cfg = JSON.parse(p.config_json);
    const mine = db().prepare('SELECT content FROM course_page_files WHERE user_id=? AND page_id=?').get(req.user.id, p.id);
    return { name: fileNameOf(cfg), content: mine ? mine.content : (cfg.fileContent ?? ''), modified: !!mine };
  };
  const saveFile = (req, p, content) => db().prepare(`INSERT INTO course_page_files (user_id, page_id, content, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(user_id, page_id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`).run(req.user.id, p.id, content, now());
  route.get('/courses/:id/pages/:pid/file', 'authenticated', (req, res) => res.json(fileDto(req, filePage(req).p)));
  route.put('/courses/:id/pages/:pid/file', 'authenticated', (req, res) => {
    const { p } = filePage(req);
    saveFile(req, p, validate(z.object({ content: z.string().max(MAX_FILE) }), req.body).content);
    res.json({ ok: true });
  });
  route.delete('/courses/:id/pages/:pid/file', 'authenticated', (req, res) => { // back to the instructor's starting text
    const { p } = filePage(req);
    db().prepare('DELETE FROM course_page_files WHERE user_id=? AND page_id=?').run(req.user.id, p.id);
    res.json(fileDto(req, p));
  });

  const MAX_USER_MESSAGES = 100; // per page and learner: keeps one conversation from growing (and costing) without bound
  const pageConversation = (req, c, p) => db().prepare("SELECT * FROM conversations WHERE user_id=? AND page_id=? AND kind='course' ORDER BY id DESC").get(req.user.id, p.id);
  route.get('/courses/:id/pages/:pid/conversation', 'authenticated', (req, res) => {
    const { c, p } = panelPage(req);
    const conv = pageConversation(req, c, p);
    res.json(conv ? { conversationId: conv.id, messages: loadMessages(conv.id).filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content)).map((m) => ({ role: m.role, content: m.content, ...(JSON.parse(p.config_json).thinking && m.thinking ? { thinking: m.thinking } : {}) })) } : { conversationId: null, messages: [] });
  });
  route.delete('/courses/:id/pages/:pid/conversation', 'authenticated', (req, res) => {
    const { c, p } = panelPage(req);
    const conv = pageConversation(req, c, p);
    if (conv) db().prepare('DELETE FROM conversations WHERE id=?').run(conv.id);
    res.json({ ok: true });
  });
  // One tutor/chat turn, streamed as server-sent events. No tools, no workspace, no web search or memory; except on an 'agent_file' page,
  // where the assistant gets the file tools for that page's one file.
  route.post('/courses/:id/pages/:pid/turn', 'authenticated', async (req, res, next) => {
    try {
      const { c, p } = panelPage(req);
      if (p.layout === 'content' || p.layout === ASSESSMENT_LAYOUT) fail(400, 'page_has_no_panel');
      const fileMode = p.layout === 'agent_file';
      const b = validate(z.object({ message: z.string().trim().min(1).max(4000), ...(fileMode ? { content: z.string().max(MAX_FILE).optional() } : {}) }), req.body);
      const cfg = JSON.parse(p.config_json);
      const rm = await resolveModel(req.user, effectiveCourseModelId(cfg.modelId) ?? getSettings('general').defaultModels.chat);
      if (!rm) fail(400, 'no_model_available');
      let conv = pageConversation(req, c, p);
      const messages = conv ? loadMessages(conv.id) : [];
      if (messages.filter((m) => m.role === 'user').length >= MAX_USER_MESSAGES) fail(429, 'conversation_limit');
      if (!conv) {
        const id = Number(db().prepare("INSERT INTO conversations (user_id, kind, title, course_id, page_id) VALUES (?,'course',?,?,?)").run(req.user.id, b.message.slice(0, 80), c.id, p.id).lastInsertRowid);
        conv = db().prepare('SELECT * FROM conversations WHERE id=?').get(id);
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
        if (b.content != null) saveFile(req, p, b.content); // what the learner has typed so far is what the agent sees
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'course-file-'));
        fs.writeFileSync(path.join(scratch, name), fileDto(req, p).content);
        const pushFile = () => { try { const content = fs.readFileSync(path.join(scratch, name), 'utf8').slice(0, MAX_FILE); saveFile(req, p, content); emit({ type: 'file', content }); } catch { /* deleted or unreadable: keep the saved copy */ } };
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
          onUsage: (u) => recordUsage({ userId: req.user.id, conversationId: conv.id, model: rm.model, provider: rm.provider, kind: 'course', ...u }),
        });
      } catch (e) { send({ type: 'error', message: 'The model request failed.' }); console.error('course turn error', e?.message); }
      finally { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); persistFrom(conv.id, messages, start); touchConversation(conv.id, { modelId: rm.model.id }); res.end(); }
    } catch (e) { if (res.headersSent) res.end(); else next(e); }
  });

  // ---------- Administration: the tutor subpanel catalog.
  route.get('/admin/course-settings', 'course.admin', (_req, res) => res.json(getSettings('courses')));
  route.put('/admin/course-settings', 'course.admin', (req, res) => {
    // Fields left out keep their current value, so the panel and model editors can save independently.
    const saved = saveSettings('courses', validate(schemas.courses, { ...getSettings('courses'), ...req.body }));
    audit(req.user.id, 'settings.courses.update', null, { subpanels: saved.subpanels.filter((x) => x.enabled).map((x) => x.id), allowedModelIds: saved.allowedModelIds });
    res.json(saved);
  });

  // Which models an instructor may choose for a course: null = any they can use.
  route.get('/courses-allowed-models', 'course.author', (_req, res) => res.json({ allowed: allowedCourseModelIds() }));

  // ---------- Exercise rules
  // The rules for a workspace, for the IDE to show: null for an ordinary project.
  route.get('/projects/:id/exercise-policy', 'project.read', async (req, res) => {
    const p = await getProject(req); const sc = scopeOf(p.id);
    res.json(sc ? { mode: sc.policy.mode, shell: sc.policy.shell, locked: sc.locked, submitted: sc.submitted, expired: sc.expired, deadline: sc.deadline, summary: describePolicy(sc.policy) } : null);
  });
  // What learners with a given role could do under a set of rules, for the exercise builder's preview.
  const RELEVANT = { 'agent.plan': 'Plan with the agent', 'agent.act': 'Let the agent change files', 'files.write': 'Edit files', 'agent.shell.run': 'Agent shell commands', 'terminal.use': 'Terminal', 'git.commit': 'Git commit', 'git.push': 'Git push', 'download.code': 'Download the project', 'checkpoint.write': 'Create and restore checkpoints', 'mcp.use': 'MCP tools', 'memory.use': 'Agent memory', 'websearch.use': 'Web search' };
  route.get('/courses-roles', 'course.author', (_req, res) => res.json(db().prepare('SELECT name FROM roles ORDER BY name').all().map((r) => r.name)));
  route.post('/courses-policy-preview', 'course.author', (req, res) => {
    const b = validate(z.object({ policy: policySchema, role: z.string().max(100) }), req.body);
    const role = db().prepare('SELECT id FROM roles WHERE name=?').get(b.role) || fail(400, 'unknown_role');
    const has = new Set(db().prepare('SELECT permission FROM role_permissions WHERE role_id=?').all(role.id).map((x) => x.permission));
    const eff = effectivePermissions(has, { denied: deniedPermissions(b.policy) });
    res.json({ summary: describePolicy(b.policy), abilities: Object.entries(RELEVANT).map(([perm, label]) => ({ label, role: has.has(perm), allowed: eff.has(perm) })) });
  });

  // Finds people to enroll or promote by name. Returns only what is needed to pick someone; at least two characters, ten results.
  route.get('/courses-users', 'course.author', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json([]);
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = db().prepare(`SELECT id, username, email, display_name, first_name, last_name FROM users WHERE disabled=0 AND
      (lower(username) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\'
       OR lower(first_name || ' ' || last_name) LIKE ? ESCAPE '\\') ORDER BY id LIMIT 10`).all(like, like, like, like);
    res.json(rows.map((u) => ({ id: u.id, label: userDto(u).displayName, username: u.username || u.email })));
  });

  // ---------- Administration: instructors, and every course with its SAML-group assignments.
  route.get('/admin/instructors', 'course.admin', (_req, res) => {
    const rows = db().prepare(`SELECT u.*, GROUP_CONCAT(DISTINCT ur.source) sources FROM user_roles ur JOIN roles r ON r.id=ur.role_id AND r.name='instructor'
      JOIN users u ON u.id=ur.user_id GROUP BY u.id ORDER BY u.id`).all();
    res.json(rows.map((u) => ({ id: u.id, label: userDto(u).displayName, username: u.username || u.email, viaSaml: u.sources.split(',').includes('saml'), manual: u.sources.split(',').includes('manual') })));
  });
  // Designating an instructor only touches the manual 'instructor' role; roles the IdP grants stay as they are.
  route.put('/admin/instructors/:userId', { perm: 'course.admin', stepup: true }, (req, res) => {
    const { instructor } = validate(z.object({ instructor: z.boolean() }), req.body);
    const u = db().prepare('SELECT id, username, email FROM users WHERE id=?').get(req.params.userId);
    const role = db().prepare("SELECT id FROM roles WHERE name='instructor'").get();
    if (!u) fail(404, 'not_found');
    if (!role) fail(409, 'instructor_role_missing');
    if (instructor) db().prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id, source) VALUES (?,?,'manual')").run(u.id, role.id);
    else db().prepare("DELETE FROM user_roles WHERE user_id=? AND role_id=? AND source='manual'").run(u.id, role.id);
    audit(req.user.id, instructor ? 'course.instructor.add' : 'course.instructor.remove', u.username || u.email, {});
    res.json({ ok: true });
  });
  route.get('/admin/courses', 'course.admin', (_req, res) => {
    const groups = db().prepare("SELECT subject_id FROM course_enrollments WHERE course_id=? AND subject_type='saml_group' ORDER BY subject_id");
    const rows = db().prepare('SELECT c.*, u.display_name, u.username, u.email FROM courses c JOIN users u ON u.id=c.owner_id ORDER BY c.updated_at DESC').all();
    res.json(rows.map((c) => ({ ...courseDto(c), owner: c.display_name || c.username || c.email, groups: groups.all(c.id).map((g) => g.subject_id) })));
  });
  // Group names the IdP has sent or that map to roles, to pick from when assigning a course.
  route.get('/admin/course-groups', 'course.admin', (_req, res) => {
    const rows = db().prepare('SELECT group_value g FROM user_saml_groups UNION SELECT group_value FROM group_role_map ORDER BY 1').all();
    res.json(rows.map((r) => r.g));
  });

  return r;
}
