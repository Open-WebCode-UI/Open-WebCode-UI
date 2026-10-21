import express from 'express';
import fs from 'node:fs';
import { getDb } from '../db/index.js';
import { defineRoutes, fail, validate, z } from '../http.js';
import { audit } from '../audit.js';
import { canAuthor, canLearn } from '../courses/access.js';
import { cleanResponse, gradeAuto, percent, isMulti, needsGrader, rowNeedsGrader } from '../courses/grading.js';
import { getCourse, authorCourse, checkModelId } from './courses.js';
import { moduleBelongsTo } from '../courses/outline.js';
import { createAssessmentPage, deleteAssessmentAndPage } from '../courses/assessment-pages.js';
import { exerciseSpec, specPoints, createWorkspace, workspaceOf, runChecks, transcriptOf, snapshot, snapshotFiles, snapshotFile, snapshotTranscript } from '../courses/exercises.js';
import { userPermissions } from '../auth/rbac.js';
import { normalizePolicy, describePolicy } from '../courses/policy.js';

const now = () => Math.floor(Date.now() / 1000);
export const assessmentBody = z.object({
  title: z.string().trim().min(1).max(200).optional(), // required to create; an update without one keeps the page's title
  moduleId: z.number().int().nullable().default(null), // where a new assessment goes
  mode: z.enum(['unscored', 'limited', 'unlimited']).optional(), // omitted: limited when maxAttempts > 0, else unlimited
  passPct: z.number().int().min(0).max(100).nullable().default(null), // minimum percent to pass; null = none
  maxAttempts: z.number().int().min(0).max(100).default(0), // only for 'limited'
});
const bad = (path, message) => fail(400, 'validation_error', { issues: [{ path, message }] });
// The three modes: unscored (no score is shown), limited (up to maxAttempts tries, the best score counts, no pass score) and unlimited.
// A pass score needs every question scored automatically, and so does an unscored assessment: nobody would grade the written ones.
export function assessmentSettings(b, questions) {
  const mode = b.mode ?? (b.maxAttempts > 0 ? 'limited' : 'unlimited');
  if (mode === 'limited') {
    if (b.maxAttempts < 1) bad('maxAttempts', 'limited attempts needs at least 1 attempt');
    if (b.passPct != null) bad('passPct', 'a pass score is only available for unscored and unlimited assessments');
  }
  if ((mode === 'unscored' || b.passPct != null) && questions.some(rowNeedsGrader)) fail(409, 'open_ended_questions');
  return { mode, passPct: b.passPct, maxAttempts: mode === 'limited' ? b.maxAttempts : 0 };
}
export const hasPassScore = (a) => a.pass_score != null;
// Whether a score satisfies the assessment: there is no bar without a pass score.
export const meetsPass = (a, score) => a.pass_score == null || score >= a.pass_score;
const points = z.number().int().min(1).max(1000).default(1);
const prompt = z.string().trim().min(1).max(4000);
export const questionBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mcq'), prompt, points, options: z.array(z.string().trim().min(1).max(500)).min(2).max(10), correct: z.array(z.number().int().min(0)).min(1) }),
  z.object({ type: z.literal('tf'), prompt, points, correct: z.boolean() }),
  z.object({ type: z.literal('text'), prompt, points, rubric: z.string().max(4000).default('') }),
  z.object({ type: z.literal('exercise'), prompt, spec: exerciseSpec }), // points come from the spec
]).superRefine((q, ctx) => {
  if (q.type === 'mcq' && (new Set(q.correct).size !== q.correct.length || q.correct.some((i) => i >= q.options.length))) ctx.addIssue({ code: 'custom', message: 'invalid_correct', path: ['correct'] });
});

export const storeQuestion = (b) => ({
  options: JSON.stringify(b.type === 'mcq' ? b.options : []),
  key: JSON.stringify(b.type === 'mcq' ? { correct: [...b.correct].sort((x, y) => x - y) } : b.type === 'tf' ? { correct: b.correct } : b.type === 'text' ? { rubric: b.rubric } : {}),
  spec: JSON.stringify(b.type === 'exercise' ? b.spec : {}),
  points: b.type === 'exercise' ? specPoints(b.spec) : b.points,
});
export const authorQuestion = (q) => { const key = JSON.parse(q.answer_key_json); return { id: q.id, type: q.type, prompt: q.prompt, points: q.points, position: q.position, options: JSON.parse(q.options_json), correct: key?.correct, rubric: key?.rubric, ...(q.type === 'exercise' ? { spec: JSON.parse(q.code_spec_json) } : {}) }; };
// Learners see the brief and what they are assessed on, but not the check parameters (paths, required text) or starter content.
const exerciseView = (q) => { const sp = JSON.parse(q.code_spec_json); return { brief: sp.brief, rules: describePolicy(normalizePolicy(sp.policy)), criteria: [...sp.checks.map((c) => ({ label: c.label, points: c.points, kind: 'check' })), ...sp.rubric.map((r) => ({ label: r.label, points: r.points, kind: 'rubric' }))] }; };
const learnerQuestion = (q) => ({ id: q.id, type: q.type, prompt: q.prompt, points: q.points, position: q.position, options: JSON.parse(q.options_json), multi: q.type === 'mcq' && isMulti(q), ...(q.type === 'exercise' ? { exercise: exerciseView(q) } : {}) });
const assessmentDto = (a) => ({ id: a.id, courseId: a.course_id, pageId: a.page_id, title: a.title, mode: a.mode, passPct: a.pass_score, maxAttempts: a.max_attempts });

export function assessmentsRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/api');
  const db = () => getDb();

  const getAssessment = (req, courseId) => db().prepare('SELECT * FROM assessments WHERE id=? AND course_id=?').get(req.params.aid, courseId) || fail(404, 'assessment_not_found');
  const questionsOf = (aid) => db().prepare('SELECT * FROM questions WHERE assessment_id=? ORDER BY position, id').all(aid);
  // Questions are fixed once anyone has attempted the assessment, so past scores always mean what they said.
  // A question that needs grading cannot join an unscored assessment or one with a pass score.
  const checkFits = (a, b) => { if ((a.mode === 'unscored' || a.pass_score != null) && needsGrader(b.type, b.type === 'exercise' ? b.spec.rubric.length : 0)) fail(409, 'open_ended_questions'); };
  const lockIfAttempted = (aid) => { if (db().prepare('SELECT 1 FROM attempts WHERE assessment_id=?').get(aid)) fail(409, 'assessment_has_attempts'); };

  // ---------- Authoring
  route.get('/courses/:id/assessments/manage', 'course.author', (req, res) => {
    const c = authorCourse(req);
    res.json(db().prepare('SELECT * FROM assessments WHERE course_id=? ORDER BY id').all(c.id)
      .map((a) => ({ ...assessmentDto(a), locked: !!db().prepare('SELECT 1 FROM attempts WHERE assessment_id=?').get(a.id), questions: questionsOf(a.id).map(authorQuestion) })));
  });
  route.post('/courses/:id/assessments', 'course.author', (req, res) => {
    const c = authorCourse(req); const b = validate(assessmentBody, req.body); if (!b.title) fail(400, 'validation_error', { issues: [{ path: 'title', message: 'required' }] }); const st = assessmentSettings(b, []);
    if (b.moduleId != null && !moduleBelongsTo(c.id, b.moduleId)) fail(404, 'module_not_found');
    const { assessmentId: id } = createAssessmentPage(c.id, { moduleId: b.moduleId, title: b.title, mode: st.mode, passScore: st.passPct, maxAttempts: st.maxAttempts });
    audit(req.user.id, 'course.assessment.create', String(c.id), { assessment: id });
    res.status(201).json({ ...assessmentDto(db().prepare('SELECT * FROM assessments WHERE id=?').get(id)), locked: false, questions: [] });
  });
  route.put('/courses/:id/assessments/:aid', 'course.author', (req, res) => {
    const c = authorCourse(req); const a = getAssessment(req, c.id); const b = validate(assessmentBody, req.body);
    const st = assessmentSettings(b, questionsOf(a.id));
    const title = b.title ?? a.title;
    db().prepare('UPDATE assessments SET title=?, mode=?, pass_score=?, max_attempts=? WHERE id=?').run(title, st.mode, st.passPct, st.maxAttempts, a.id);
    if (a.page_id) db().prepare('UPDATE course_pages SET title=? WHERE id=?').run(title, a.page_id); // the page and its assessment share a title
    audit(req.user.id, 'course.assessment.update', String(c.id), { assessment: a.id });
    res.json(assessmentDto(db().prepare('SELECT * FROM assessments WHERE id=?').get(a.id)));
  });
  route.delete('/courses/:id/assessments/:aid', 'course.author', (req, res) => {
    const c = authorCourse(req); const a = getAssessment(req, c.id);
    deleteAssessmentAndPage(a);
    audit(req.user.id, 'course.assessment.delete', String(c.id), { assessment: a.id, title: a.title });
    res.json({ ok: true });
  });
  route.post('/courses/:id/assessments/:aid/questions', 'course.author', (req, res) => {
    const c = authorCourse(req); const a = getAssessment(req, c.id); lockIfAttempted(a.id);
    const b = validate(questionBody, req.body); checkFits(a, b); if (b.type === 'exercise') checkModelId(req, b.spec.policy.modelId); const s = storeQuestion(b);
    const pos = (db().prepare('SELECT MAX(position) m FROM questions WHERE assessment_id=?').get(a.id).m ?? -1) + 1;
    const id = Number(db().prepare('INSERT INTO questions (assessment_id, position, type, prompt, options_json, answer_key_json, points, code_spec_json) VALUES (?,?,?,?,?,?,?,?)').run(a.id, pos, b.type, b.prompt, s.options, s.key, s.points, s.spec).lastInsertRowid);
    res.status(201).json(authorQuestion(db().prepare('SELECT * FROM questions WHERE id=?').get(id)));
  });
  const getQuestion = (req, aid) => db().prepare('SELECT * FROM questions WHERE id=? AND assessment_id=?').get(req.params.qid, aid) || fail(404, 'question_not_found');
  route.put('/courses/:id/assessments/:aid/questions/:qid', 'course.author', (req, res) => {
    const c = authorCourse(req); const a = getAssessment(req, c.id); lockIfAttempted(a.id); const q = getQuestion(req, a.id);
    const b = validate(questionBody, req.body); checkFits(a, b); if (b.type === 'exercise') checkModelId(req, b.spec.policy.modelId); const s = storeQuestion(b);
    db().prepare('UPDATE questions SET type=?, prompt=?, options_json=?, answer_key_json=?, points=?, code_spec_json=? WHERE id=?').run(b.type, b.prompt, s.options, s.key, s.points, s.spec, q.id);
    res.json(authorQuestion(db().prepare('SELECT * FROM questions WHERE id=?').get(q.id)));
  });
  route.delete('/courses/:id/assessments/:aid/questions/:qid', 'course.author', (req, res) => {
    const c = authorCourse(req); const a = getAssessment(req, c.id); lockIfAttempted(a.id); const q = getQuestion(req, a.id);
    db().prepare('DELETE FROM questions WHERE id=?').run(q.id);
    res.json({ ok: true });
  });
  route.put('/courses/:id/assessments/:aid/questions-order', 'course.author', (req, res) => {
    const c = authorCourse(req); const a = getAssessment(req, c.id);
    const { ids } = validate(z.object({ ids: z.array(z.number().int()) }), req.body);
    const have = questionsOf(a.id).map((q) => q.id).sort((x, y) => x - y);
    if (JSON.stringify([...ids].sort((x, y) => x - y)) !== JSON.stringify(have)) fail(400, 'order_mismatch');
    const upd = db().prepare('UPDATE questions SET position=? WHERE id=?');
    db().transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
    res.json({ ok: true });
  });

  // ---------- Taking: summaries, attempts
  const attemptInfo = (userId, a) => {
    const rows = db().prepare("SELECT status, score FROM attempts WHERE assessment_id=? AND user_id=? ORDER BY id").all(a.id, userId);
    const done = rows.filter((x) => x.status !== 'in_progress');
    const graded = done.filter((x) => x.status === 'graded');
    const best = graded.length ? Math.max(...graded.map((x) => x.score)) : null;
    // passed = the requirement is met: a graded attempt, and the pass score if there is one. An unscored assessment never reveals scores.
    return { attemptsUsed: done.length, inProgress: rows.some((x) => x.status === 'in_progress'), awaitingGrade: done.some((x) => x.status === 'submitted'), bestScore: a.mode === 'unscored' ? null : best, passed: best != null && meetsPass(a, best) };
  };
  route.get('/courses/:id/assessments', 'authenticated', (req, res) => {
    const c = getCourse(req);
    if (!canLearn(req.user.id, c) && !canAuthor(req.user.id, c)) fail(404, 'course_not_found');
    res.json(db().prepare('SELECT * FROM assessments WHERE course_id=? ORDER BY id').all(c.id).map((a) => {
      const qs = questionsOf(a.id);
      return { ...assessmentDto(a), questionCount: qs.length, totalPoints: qs.reduce((n, q) => n + q.points, 0), ...attemptInfo(req.user.id, a) };
    }));
  });

  const attemptView = (att, a, { owner }) => {
    const answers = new Map(db().prepare('SELECT * FROM answers WHERE attempt_id=?').all(att.id).map((x) => [x.question_id, x]));
    const open = att.status === 'in_progress';
    const perms = userPermissions(att.user_id); // can the learner use the agent on their workspace? (their own permissions apply)
    const agentAccess = ['agent.plan', 'project.read', 'files.read', 'provider.use'].every((p) => perms.has(p));
    return {
      id: att.id, assessmentId: a.id, title: a.title, status: att.status, startedAt: att.started_at, submittedAt: att.submitted_at, mode: a.mode, passPct: a.pass_score,
      score: open || a.mode === 'unscored' ? null : att.score, passed: att.status === 'graded' ? meetsPass(a, att.score) : null,
      questions: questionsOf(a.id).map((q) => {
        const an = answers.get(q.id);
        const ex = q.type === 'exercise' ? { workspace: { projectId: workspaceOf(att.id, q.id)?.project_id ?? null }, canUseAgent: agentAccess } : {};
        return { ...learnerQuestion(q), ...(ex.workspace ? { exercise: { ...learnerQuestion(q).exercise, ...ex } } : {}), response: an ? JSON.parse(an.response_json) : null, ...(open ? {} : { earned: an?.score ?? null, feedback: an?.feedback || '' }), ...(owner || q.type === 'exercise' ? {} : { rubric: JSON.parse(q.answer_key_json)?.rubric }) };
      }),
    };
  };
  const learnerAssessment = (req) => {
    const c = getCourse(req);
    if (!canLearn(req.user.id, c)) fail(404, 'course_not_found');
    return { c, a: getAssessment(req, c.id) };
  };
  route.post('/courses/:id/assessments/:aid/attempts', 'course.learn', (req, res) => {
    const { a } = learnerAssessment(req);
    if (!questionsOf(a.id).length) fail(409, 'assessment_empty');
    let att = db().prepare("SELECT * FROM attempts WHERE assessment_id=? AND user_id=? AND status='in_progress'").get(a.id, req.user.id);
    if (!att) {
      if (a.max_attempts && attemptInfo(req.user.id, a).attemptsUsed >= a.max_attempts) fail(403, 'attempts_exhausted');
      att = db().prepare('SELECT * FROM attempts WHERE id=?').get(Number(db().prepare('INSERT INTO attempts (assessment_id, user_id) VALUES (?,?)').run(a.id, req.user.id).lastInsertRowid));
      try { for (const q of questionsOf(a.id).filter((x) => x.type === 'exercise')) createWorkspace(req.user.id, a.course_id, att.id, q); }
      catch (e) { db().prepare('DELETE FROM attempts WHERE id=?').run(att.id); throw e; } // no half-built attempt
    }
    res.status(201).json(attemptView(att, a, { owner: true }));
  });
  const ownAttempt = (req) => {
    const c = getCourse(req);
    const att = db().prepare('SELECT att.* FROM attempts att JOIN assessments a ON a.id=att.assessment_id WHERE att.id=? AND a.course_id=?').get(req.params.attemptId, c.id);
    if (!att) fail(404, 'attempt_not_found');
    const a = db().prepare('SELECT * FROM assessments WHERE id=?').get(att.assessment_id);
    if (att.user_id === req.user.id) { if (!canLearn(req.user.id, c)) fail(404, 'attempt_not_found'); return { c, att, a, owner: true }; }
    if (!canAuthor(req.user.id, c)) fail(404, 'attempt_not_found'); // never reveal another learner's attempt
    return { c, att, a, owner: false };
  };
  route.get('/courses/:id/attempts/:attemptId', 'authenticated', (req, res) => { const { att, a, owner } = ownAttempt(req); res.json(attemptView(att, a, { owner })); });

  // Submitting grades the auto-graded questions right away; text questions leave the attempt "submitted" until an instructor grades them.
  route.post('/courses/:id/attempts/:attemptId/submit', 'course.learn', (req, res) => {
    const { c, att, a, owner } = ownAttempt(req);
    if (!owner) fail(403, 'forbidden');
    const b = validate(z.object({ answers: z.record(z.string(), z.any()) }), req.body);
    const qs = questionsOf(a.id);
    let rows;
    try { rows = qs.map((q) => { const resp = cleanResponse(q, b.answers[q.id] ?? null); return { q, resp, score: gradeAuto(q, resp) }; }); }
    catch { return fail(400, 'invalid_response'); }
    const ins = db().prepare('INSERT INTO answers (attempt_id, question_id, response_json, score) VALUES (?,?,?,?)');
    db().transaction(() => {
      const claimed = db().prepare("UPDATE attempts SET status='submitted', submitted_at=? WHERE id=? AND status='in_progress'").run(now(), att.id);
      if (!claimed.changes) fail(409, 'already_submitted'); // a second submit (double click, two tabs) must not grade twice
      for (const x of rows) {
        if (x.q.type === 'exercise') Object.assign(x, evaluateExercise(att, x.q)); // from the workspace and transcript, never from the request
        ins.run(att.id, x.q.id, JSON.stringify(x.resp), x.score);
      }
      finalize(att.id, c.id, a);
    })();
    res.json(attemptView(db().prepare('SELECT * FROM attempts WHERE id=?').get(att.id), a, { owner: true }));
  });

  // Runs the declarative checks against the learner's workspace, keeps a snapshot for the instructor, and scores the automatic part.
  // With rubric items the answer waits for the instructor (score null); with none it is complete.
  function evaluateExercise(att, q) {
    const spec = JSON.parse(q.code_spec_json);
    const ws = workspaceOf(att.id, q.id);
    const project = ws?.project_id ? db().prepare('SELECT * FROM projects WHERE id=?').get(ws.project_id) : null;
    const dir = project && fs.existsSync(project.dir) ? project.dir : null;
    const transcript = transcriptOf(project?.id);
    const checks = runChecks(spec, { dir, transcript });
    const autoScore = checks.reduce((n, x) => n + x.earned, 0);
    const rel = snapshot(att.id, q.id, dir, transcript);
    db().prepare('UPDATE exercise_workspaces SET snapshot=? WHERE attempt_id=? AND question_id=?').run(rel, att.id, q.id); // the frozen policy stays as it was
    return { resp: { checks, autoScore, rubricScores: spec.rubric.length ? null : [] }, score: spec.rubric.length ? null : autoScore };
  }

  // Recomputes the score; graded once nothing is waiting on an instructor. A passing graded attempt completes the assessment's page.
  function finalize(attemptId, courseId, a) {
    const rows = db().prepare('SELECT an.score, an.response_json, q.points FROM answers an JOIN questions q ON q.id=an.question_id WHERE an.attempt_id=?').all(attemptId);
    const pending = rows.some((x) => x.score == null);
    // While an exercise waits for its rubric, the points its automatic checks already earned count towards the interim score.
    const earned = (x) => x.score ?? JSON.parse(x.response_json)?.autoScore ?? 0;
    const score = percent(rows.reduce((n, x) => n + earned(x), 0), rows.reduce((n, x) => n + x.points, 0));
    db().prepare('UPDATE attempts SET status=?, score=? WHERE id=?').run(pending ? 'submitted' : 'graded', score, attemptId);
    if (!pending && meetsPass(a, score) && a.page_id) {
      const user = db().prepare('SELECT user_id FROM attempts WHERE id=?').get(attemptId).user_id;
      db().prepare('INSERT OR IGNORE INTO course_progress (course_id, user_id, page_id) VALUES (?,?,?)').run(courseId, user, a.page_id);
    }
  }

  // ---------- Grading
  route.get('/courses/:id/assessments/:aid/attempts', 'course.author', (req, res) => {
    const c = authorCourse(req); const a = getAssessment(req, c.id);
    res.json(db().prepare(`SELECT att.id, att.status, CASE WHEN ? THEN NULL ELSE att.score END score, att.submitted_at submittedAt, u.id userId, COALESCE(NULLIF(u.display_name,''), u.username, u.email) learner
      FROM attempts att JOIN users u ON u.id=att.user_id WHERE att.assessment_id=? AND att.status!='in_progress' ORDER BY att.id DESC`).all(a.mode === 'unscored' ? 1 : 0, a.id));
  });
  route.put('/courses/:id/attempts/:attemptId/answers/:qid/grade', 'course.author', (req, res) => {
    const c = authorCourse(req);
    const att = db().prepare('SELECT att.* FROM attempts att JOIN assessments a ON a.id=att.assessment_id WHERE att.id=? AND a.course_id=?').get(req.params.attemptId, c.id) || fail(404, 'attempt_not_found');
    if (att.status === 'in_progress') fail(409, 'not_submitted');
    const q = db().prepare('SELECT * FROM questions WHERE id=? AND assessment_id=?').get(req.params.qid, att.assessment_id) || fail(404, 'question_not_found');
    const a = db().prepare('SELECT * FROM assessments WHERE id=?').get(att.assessment_id);
    let score; let response = null; let feedback;
    if (q.type === 'text') {
      ({ score, feedback } = validate(z.object({ score: z.number().min(0).max(q.points), feedback: z.string().max(4000).default('') }), req.body));
    } else if (q.type === 'exercise') {
      // Exercises are scored as the automatic checks plus one mark per rubric item.
      const spec = JSON.parse(q.code_spec_json);
      if (!spec.rubric.length) fail(400, 'not_manually_graded');
      const b = validate(z.object({ rubric: z.array(z.number().min(0)).length(spec.rubric.length), feedback: z.string().max(4000).default('') }), req.body);
      if (b.rubric.some((v, i) => v > spec.rubric[i].points)) fail(400, 'validation_error', { issues: [{ path: 'rubric', message: 'above the item maximum' }] });
      const prev = JSON.parse(db().prepare('SELECT response_json FROM answers WHERE attempt_id=? AND question_id=?').get(att.id, q.id).response_json);
      response = { ...prev, rubricScores: b.rubric }; feedback = b.feedback; score = (prev.autoScore ?? 0) + b.rubric.reduce((n, v) => n + v, 0);
    } else fail(400, 'not_manually_graded');
    db().transaction(() => {
      db().prepare(`UPDATE answers SET score=?, feedback=?, graded_by=?${response ? ', response_json=?' : ''} WHERE attempt_id=? AND question_id=?`).run(...[score, feedback, req.user.id, ...(response ? [JSON.stringify(response)] : []), att.id, q.id]);
      finalize(att.id, c.id, a);
    })();
    audit(req.user.id, 'course.grade', String(c.id), { attempt: att.id, question: q.id, score });
    res.json(attemptView(db().prepare('SELECT * FROM attempts WHERE id=?').get(att.id), a, { owner: false }));
  });

  // ---------- Evidence for exercises: the submitted workspace and the agent transcript (instructors only, read-only)
  const evidence = (req) => {
    const c = authorCourse(req);
    const att = db().prepare('SELECT att.* FROM attempts att JOIN assessments a ON a.id=att.assessment_id WHERE att.id=? AND a.course_id=?').get(req.params.attemptId, c.id) || fail(404, 'attempt_not_found');
    if (att.status === 'in_progress') fail(409, 'not_submitted');
    const ws = workspaceOf(att.id, req.params.qid);
    if (!ws?.snapshot) fail(404, 'no_snapshot');
    return ws.snapshot;
  };
  route.get('/courses/:id/attempts/:attemptId/exercises/:qid/files', 'course.author', (req, res) => res.json({ files: snapshotFiles(evidence(req)) }));
  route.get('/courses/:id/attempts/:attemptId/exercises/:qid/file', 'course.author', (req, res) => {
    const rel = evidence(req);
    try { res.json({ path: req.query.path, content: snapshotFile(rel, String(req.query.path || '')) }); } catch { fail(404, 'file_not_found'); }
  });
  route.get('/courses/:id/attempts/:attemptId/exercises/:qid/transcript', 'course.author', (req, res) => res.json({ messages: snapshotTranscript(evidence(req)) }));

  return r;
}
