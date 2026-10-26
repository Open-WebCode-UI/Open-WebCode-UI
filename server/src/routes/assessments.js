import express from 'express';
import fs from 'node:fs';
import { getKnex } from '../db/index.js';
import { trx, insertId } from '../db/dialect.js';
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
  const k = () => getKnex();
  const intParam = (v) => { const n = Number(v); return Number.isInteger(n) ? n : null; };

  const getAssessment = async (req, courseId) => {
    const id = intParam(req.params.aid);
    return (id !== null && await k()('assessments').where({ id, course_id: courseId }).first()) || fail(404, 'assessment_not_found');
  };
  const questionsOf = (aid) => k()('questions').where({ assessment_id: aid }).orderBy([{ column: 'position' }, { column: 'id' }]);
  // Questions are fixed once anyone has attempted the assessment, so past scores always mean what they said.
  // A question that needs grading cannot join an unscored assessment or one with a pass score.
  const checkFits = (a, b) => { if ((a.mode === 'unscored' || a.pass_score != null) && needsGrader(b.type, b.type === 'exercise' ? b.spec.rubric.length : 0)) fail(409, 'open_ended_questions'); };
  const lockIfAttempted = async (aid) => { if (await k()('attempts').where({ assessment_id: aid }).first('id')) fail(409, 'assessment_has_attempts'); };

  // ---------- Authoring
  route.get('/courses/:id/assessments/manage', 'course.author', async (req, res) => {
    const c = await authorCourse(req);
    const rows = await k()('assessments').where({ course_id: c.id }).orderBy('id');
    res.json(await Promise.all(rows.map(async (a) => ({ ...assessmentDto(a), locked: !!(await k()('attempts').where({ assessment_id: a.id }).first('id')), questions: (await questionsOf(a.id)).map(authorQuestion) }))));
  });
  route.post('/courses/:id/assessments', 'course.author', async (req, res) => {
    const c = await authorCourse(req); const b = validate(assessmentBody, req.body); if (!b.title) fail(400, 'validation_error', { issues: [{ path: 'title', message: 'required' }] }); const st = assessmentSettings(b, []);
    if (b.moduleId != null && !(await moduleBelongsTo(c.id, b.moduleId))) fail(404, 'module_not_found');
    const { assessmentId: id } = await createAssessmentPage(c.id, { moduleId: b.moduleId, title: b.title, mode: st.mode, passScore: st.passPct, maxAttempts: st.maxAttempts });
    audit(req.user.id, 'course.assessment.create', String(c.id), { assessment: id });
    res.status(201).json({ ...assessmentDto(await k()('assessments').where({ id }).first()), locked: false, questions: [] });
  });
  route.put('/courses/:id/assessments/:aid', 'course.author', async (req, res) => {
    const c = await authorCourse(req); const a = await getAssessment(req, c.id); const b = validate(assessmentBody, req.body);
    const st = assessmentSettings(b, await questionsOf(a.id));
    const title = b.title ?? a.title;
    await k()('assessments').where({ id: a.id }).update({ title, mode: st.mode, pass_score: st.passPct, max_attempts: st.maxAttempts });
    if (a.page_id) await k()('course_pages').where({ id: a.page_id }).update({ title }); // the page and its assessment share a title
    audit(req.user.id, 'course.assessment.update', String(c.id), { assessment: a.id });
    res.json(assessmentDto(await k()('assessments').where({ id: a.id }).first()));
  });
  route.delete('/courses/:id/assessments/:aid', 'course.author', async (req, res) => {
    const c = await authorCourse(req); const a = await getAssessment(req, c.id);
    await deleteAssessmentAndPage(a);
    audit(req.user.id, 'course.assessment.delete', String(c.id), { assessment: a.id, title: a.title });
    res.json({ ok: true });
  });
  route.post('/courses/:id/assessments/:aid/questions', 'course.author', async (req, res) => {
    const c = await authorCourse(req); const a = await getAssessment(req, c.id); await lockIfAttempted(a.id);
    const b = validate(questionBody, req.body); checkFits(a, b); if (b.type === 'exercise') await checkModelId(req, b.spec.policy.modelId); const s = storeQuestion(b);
    const id = await trx(k(), async (t) => insertId(t('questions'), {
      assessment_id: a.id, position: ((await t('questions').where({ assessment_id: a.id }).max({ m: 'position' }).first()).m ?? -1) + 1,
      type: b.type, prompt: b.prompt, options_json: s.options, answer_key_json: s.key, points: s.points, code_spec_json: s.spec,
    }));
    res.status(201).json(authorQuestion(await k()('questions').where({ id }).first()));
  });
  const getQuestion = async (req, aid) => {
    const id = intParam(req.params.qid);
    return (id !== null && await k()('questions').where({ id, assessment_id: aid }).first()) || fail(404, 'question_not_found');
  };
  route.put('/courses/:id/assessments/:aid/questions/:qid', 'course.author', async (req, res) => {
    const c = await authorCourse(req); const a = await getAssessment(req, c.id); await lockIfAttempted(a.id); const q = await getQuestion(req, a.id);
    const b = validate(questionBody, req.body); checkFits(a, b); if (b.type === 'exercise') await checkModelId(req, b.spec.policy.modelId); const s = storeQuestion(b);
    await k()('questions').where({ id: q.id }).update({ type: b.type, prompt: b.prompt, options_json: s.options, answer_key_json: s.key, points: s.points, code_spec_json: s.spec });
    res.json(authorQuestion(await k()('questions').where({ id: q.id }).first()));
  });
  route.delete('/courses/:id/assessments/:aid/questions/:qid', 'course.author', async (req, res) => {
    const c = await authorCourse(req); const a = await getAssessment(req, c.id); await lockIfAttempted(a.id); const q = await getQuestion(req, a.id);
    await k()('questions').where({ id: q.id }).del();
    res.json({ ok: true });
  });
  route.put('/courses/:id/assessments/:aid/questions-order', 'course.author', async (req, res) => {
    const c = await authorCourse(req); const a = await getAssessment(req, c.id);
    const { ids } = validate(z.object({ ids: z.array(z.number().int()) }), req.body);
    const have = (await questionsOf(a.id)).map((q) => q.id).sort((x, y) => x - y);
    if (JSON.stringify([...ids].sort((x, y) => x - y)) !== JSON.stringify(have)) fail(400, 'order_mismatch');
    await trx(k(), async (t) => { for (const [i, id] of ids.entries()) await t('questions').where({ id }).update({ position: i }); });
    res.json({ ok: true });
  });

  // ---------- Taking: summaries, attempts
  const attemptInfo = async (userId, a) => {
    const rows = await k()('attempts').where({ assessment_id: a.id, user_id: userId }).orderBy('id').select('status', 'score');
    const done = rows.filter((x) => x.status !== 'in_progress');
    const graded = done.filter((x) => x.status === 'graded');
    const best = graded.length ? Math.max(...graded.map((x) => x.score)) : null;
    // passed = the requirement is met: a graded attempt, and the pass score if there is one. An unscored assessment never reveals scores.
    return { attemptsUsed: done.length, inProgress: rows.some((x) => x.status === 'in_progress'), awaitingGrade: done.some((x) => x.status === 'submitted'), bestScore: a.mode === 'unscored' ? null : best, passed: best != null && meetsPass(a, best) };
  };
  route.get('/courses/:id/assessments', 'authenticated', async (req, res) => {
    const c = await getCourse(req);
    if (!(await canLearn(req.user.id, c)) && !(await canAuthor(req.user.id, c))) fail(404, 'course_not_found');
    const rows = await k()('assessments').where({ course_id: c.id }).orderBy('id');
    res.json(await Promise.all(rows.map(async (a) => {
      const qs = await questionsOf(a.id);
      return { ...assessmentDto(a), questionCount: qs.length, totalPoints: qs.reduce((n, q) => n + q.points, 0), ...(await attemptInfo(req.user.id, a)) };
    })));
  });

  const attemptView = async (att, a, { owner }) => {
    const answers = new Map((await k()('answers').where({ attempt_id: att.id })).map((x) => [x.question_id, x]));
    const open = att.status === 'in_progress';
    const perms = userPermissions(att.user_id); // can the learner use the agent on their workspace? (their own permissions apply)
    const agentAccess = ['agent.plan', 'project.read', 'files.read', 'provider.use'].every((p) => perms.has(p));
    return {
      id: att.id, assessmentId: a.id, title: a.title, status: att.status, startedAt: att.started_at, submittedAt: att.submitted_at, mode: a.mode, passPct: a.pass_score,
      score: open || a.mode === 'unscored' ? null : att.score, passed: att.status === 'graded' ? meetsPass(a, att.score) : null,
      questions: await Promise.all((await questionsOf(a.id)).map(async (q) => {
        const an = answers.get(q.id);
        const ex = q.type === 'exercise' ? { workspace: { projectId: (await workspaceOf(att.id, q.id))?.project_id ?? null }, canUseAgent: agentAccess } : {};
        return { ...learnerQuestion(q), ...(ex.workspace ? { exercise: { ...learnerQuestion(q).exercise, ...ex } } : {}), response: an ? JSON.parse(an.response_json) : null, ...(open ? {} : { earned: an?.score ?? null, feedback: an?.feedback || '' }), ...(owner || q.type === 'exercise' ? {} : { rubric: JSON.parse(q.answer_key_json)?.rubric }) };
      })),
    };
  };
  const learnerAssessment = async (req) => {
    const c = await getCourse(req);
    if (!(await canLearn(req.user.id, c))) fail(404, 'course_not_found');
    return { c, a: await getAssessment(req, c.id) };
  };
  route.post('/courses/:id/assessments/:aid/attempts', 'course.learn', async (req, res) => {
    const { a } = await learnerAssessment(req);
    const questions = await questionsOf(a.id);
    if (!questions.length) fail(409, 'assessment_empty');
    let att = await k()('attempts').where({ assessment_id: a.id, user_id: req.user.id, status: 'in_progress' }).first();
    if (!att) {
      if (a.max_attempts && (await attemptInfo(req.user.id, a)).attemptsUsed >= a.max_attempts) fail(403, 'attempts_exhausted');
      att = await k()('attempts').where({ id: await insertId(k()('attempts'), { assessment_id: a.id, user_id: req.user.id }) }).first();
      try { for (const q of questions.filter((x) => x.type === 'exercise')) await createWorkspace(req.user.id, a.course_id, att.id, q); }
      catch (e) { await k()('attempts').where({ id: att.id }).del(); throw e; } // no half-built attempt
    }
    res.status(201).json(await attemptView(att, a, { owner: true }));
  });
  const ownAttempt = async (req) => {
    const c = await getCourse(req);
    const attemptId = intParam(req.params.attemptId);
    const att = attemptId === null ? null : await k()('attempts as att').join('assessments as a', 'a.id', 'att.assessment_id').where({ 'att.id': attemptId, 'a.course_id': c.id }).first('att.*');
    if (!att) fail(404, 'attempt_not_found');
    const a = await k()('assessments').where({ id: att.assessment_id }).first();
    if (att.user_id === req.user.id) { if (!(await canLearn(req.user.id, c))) fail(404, 'attempt_not_found'); return { c, att, a, owner: true }; }
    if (!(await canAuthor(req.user.id, c))) fail(404, 'attempt_not_found'); // never reveal another learner's attempt
    return { c, att, a, owner: false };
  };
  route.get('/courses/:id/attempts/:attemptId', 'authenticated', async (req, res) => { const { att, a, owner } = await ownAttempt(req); res.json(await attemptView(att, a, { owner })); });

  // Submitting grades the auto-graded questions right away; text questions leave the attempt "submitted" until an instructor grades them.
  route.post('/courses/:id/attempts/:attemptId/submit', 'course.learn', async (req, res) => {
    const { c, att, a, owner } = await ownAttempt(req);
    if (!owner) fail(403, 'forbidden');
    const b = validate(z.object({ answers: z.record(z.string(), z.any()) }), req.body);
    const qs = await questionsOf(a.id);
    let rows;
    try { rows = qs.map((q) => { const resp = cleanResponse(q, b.answers[q.id] ?? null); return { q, resp, score: gradeAuto(q, resp) }; }); }
    catch { return fail(400, 'invalid_response'); }
    // One atomic update claims the attempt, so a second submit (double click, two tabs) cannot grade twice.
    if (!(await k()('attempts').where({ id: att.id, status: 'in_progress' }).update({ status: 'submitted', submitted_at: now() }))) fail(409, 'already_submitted');
    try {
      for (const x of rows) if (x.q.type === 'exercise') Object.assign(x, await evaluateExercise(att, x.q)); // from the workspace and transcript, never from the request
      await trx(k(), async (t) => {
        await t('answers').insert(rows.map((x) => ({ attempt_id: att.id, question_id: x.q.id, response_json: JSON.stringify(x.resp), score: x.score })));
        await finalize(att.id, c.id, a, t);
      });
    } catch (e) { // nothing was graded: the learner can submit again
      await k()('answers').where({ attempt_id: att.id }).del(); await k()('attempts').where({ id: att.id }).update({ status: 'in_progress', submitted_at: null });
      throw e;
    }
    res.json(await attemptView(await k()('attempts').where({ id: att.id }).first(), a, { owner: true }));
  });

  // Runs the declarative checks against the learner's workspace, keeps a snapshot for the instructor, and scores the automatic part.
  // With rubric items the answer waits for the instructor (score null); with none it is complete.
  async function evaluateExercise(att, q) {
    const spec = JSON.parse(q.code_spec_json);
    const ws = await workspaceOf(att.id, q.id);
    const project = ws?.project_id ? await k()('projects').where({ id: ws.project_id }).first() : null;
    const dir = project && fs.existsSync(project.dir) ? project.dir : null;
    const transcript = await transcriptOf(project?.id);
    const checks = runChecks(spec, { dir, transcript });
    const autoScore = checks.reduce((n, x) => n + x.earned, 0);
    const rel = snapshot(att.id, q.id, dir, transcript);
    await k()('exercise_workspaces').where({ attempt_id: att.id, question_id: q.id }).update({ snapshot: rel }); // the frozen policy stays as it was
    return { resp: { checks, autoScore, rubricScores: spec.rubric.length ? null : [] }, score: spec.rubric.length ? null : autoScore };
  }

  // Recomputes the score; graded once nothing is waiting on an instructor. A passing graded attempt completes the assessment's page.
  async function finalize(attemptId, courseId, a, t = k()) {
    const rows = await t('answers as an').join('questions as q', 'q.id', 'an.question_id').where('an.attempt_id', attemptId).select('an.score', 'an.response_json', 'q.points');
    const pending = rows.some((x) => x.score == null);
    // While an exercise waits for its rubric, the points its automatic checks already earned count towards the interim score.
    const earned = (x) => x.score ?? JSON.parse(x.response_json)?.autoScore ?? 0;
    const score = percent(rows.reduce((n, x) => n + earned(x), 0), rows.reduce((n, x) => n + x.points, 0));
    await t('attempts').where({ id: attemptId }).update({ status: pending ? 'submitted' : 'graded', score });
    if (!pending && meetsPass(a, score) && a.page_id) {
      const { user_id: user } = await t('attempts').where({ id: attemptId }).first('user_id');
      await t('course_progress').insert({ course_id: courseId, user_id: user, page_id: a.page_id }).onConflict(['user_id', 'page_id']).ignore();
    }
  }

  // ---------- Grading
  route.get('/courses/:id/assessments/:aid/attempts', 'course.author', async (req, res) => {
    const c = await authorCourse(req); const a = await getAssessment(req, c.id);
    const rows = await k()('attempts as att').join('users as u', 'u.id', 'att.user_id').where('att.assessment_id', a.id).whereNot('att.status', 'in_progress').orderBy('att.id', 'desc')
      .select('att.id', 'att.status', 'att.score', 'att.submitted_at as submittedAt', 'u.id as userId', k().raw("COALESCE(NULLIF(u.display_name, ''), u.username, u.email) as learner"));
    res.json(rows.map((x) => ({ ...x, score: a.mode === 'unscored' ? null : x.score })));
  });
  route.put('/courses/:id/attempts/:attemptId/answers/:qid/grade', 'course.author', async (req, res) => {
    const c = await authorCourse(req);
    const attemptId = intParam(req.params.attemptId), qid = intParam(req.params.qid);
    const att = (attemptId !== null && await k()('attempts as att').join('assessments as a', 'a.id', 'att.assessment_id').where({ 'att.id': attemptId, 'a.course_id': c.id }).first('att.*')) || fail(404, 'attempt_not_found');
    if (att.status === 'in_progress') fail(409, 'not_submitted');
    const q = (qid !== null && await k()('questions').where({ id: qid, assessment_id: att.assessment_id }).first()) || fail(404, 'question_not_found');
    const a = await k()('assessments').where({ id: att.assessment_id }).first();
    let score; let response = null; let feedback;
    if (q.type === 'text') {
      ({ score, feedback } = validate(z.object({ score: z.number().min(0).max(q.points), feedback: z.string().max(4000).default('') }), req.body));
    } else if (q.type === 'exercise') {
      // Exercises are scored as the automatic checks plus one mark per rubric item.
      const spec = JSON.parse(q.code_spec_json);
      if (!spec.rubric.length) fail(400, 'not_manually_graded');
      const b = validate(z.object({ rubric: z.array(z.number().min(0)).length(spec.rubric.length), feedback: z.string().max(4000).default('') }), req.body);
      if (b.rubric.some((v, i) => v > spec.rubric[i].points)) fail(400, 'validation_error', { issues: [{ path: 'rubric', message: 'above the item maximum' }] });
      const prev = JSON.parse((await k()('answers').where({ attempt_id: att.id, question_id: q.id }).first('response_json')).response_json);
      response = { ...prev, rubricScores: b.rubric }; feedback = b.feedback; score = (prev.autoScore ?? 0) + b.rubric.reduce((n, v) => n + v, 0);
    } else fail(400, 'not_manually_graded');
    await trx(k(), async (t) => {
      await t('answers').where({ attempt_id: att.id, question_id: q.id }).update({ score, feedback, graded_by: req.user.id, ...(response && { response_json: JSON.stringify(response) }) });
      await finalize(att.id, c.id, a, t);
    });
    audit(req.user.id, 'course.grade', String(c.id), { attempt: att.id, question: q.id, score });
    res.json(await attemptView(await k()('attempts').where({ id: att.id }).first(), a, { owner: false }));
  });

  // ---------- Evidence for exercises: the submitted workspace and the agent transcript (instructors only, read-only)
  const evidence = async (req) => {
    const c = await authorCourse(req);
    const attemptId = intParam(req.params.attemptId);
    const att = (attemptId !== null && await k()('attempts as att').join('assessments as a', 'a.id', 'att.assessment_id').where({ 'att.id': attemptId, 'a.course_id': c.id }).first('att.*')) || fail(404, 'attempt_not_found');
    if (att.status === 'in_progress') fail(409, 'not_submitted');
    const ws = await workspaceOf(att.id, intParam(req.params.qid));
    if (!ws?.snapshot) fail(404, 'no_snapshot');
    return ws.snapshot;
  };
  route.get('/courses/:id/attempts/:attemptId/exercises/:qid/files', 'course.author', async (req, res) => res.json({ files: snapshotFiles(await evidence(req)) }));
  route.get('/courses/:id/attempts/:attemptId/exercises/:qid/file', 'course.author', async (req, res) => {
    const rel = await evidence(req);
    try { res.json({ path: req.query.path, content: snapshotFile(rel, String(req.query.path || '')) }); } catch { fail(404, 'file_not_found'); }
  });
  route.get('/courses/:id/attempts/:attemptId/exercises/:qid/transcript', 'course.author', async (req, res) => res.json({ messages: snapshotTranscript(await evidence(req)) }));

  return r;
}
