import { getKnex } from '../db/index.js';
import { trx, insertId } from '../db/dialect.js';
import { nextPosition } from './outline.js';
import { removeSnapshots } from './exercises.js';

// An assessment is a page of layout 'assessment': it sits in the outline like any other page, its text is the introduction learners
// read first, and assessments.page_id points back at it (one to one). Finishing the assessment completes that page.
export const ASSESSMENT_LAYOUT = 'assessment';

export function createAssessmentPage(courseId, { moduleId = null, title, content = {}, mode = 'unlimited', passScore = null, maxAttempts = 0 }) {
  return trx(getKnex(), async (t) => {
    const pageId = await insertId(t('course_pages'), {
      course_id: courseId, module_id: moduleId, position: await nextPosition(courseId, moduleId, t), title, layout: ASSESSMENT_LAYOUT, content_json: JSON.stringify(content), config_json: '{}',
    });
    const id = await insertId(t('assessments'), { course_id: courseId, page_id: pageId, title, mode, pass_score: passScore, max_attempts: maxAttempts });
    return { pageId, assessmentId: id };
  });
}

// Removes the assessment, every attempt at it (and their saved workspaces), and its page.
export async function deleteAssessmentAndPage(assessment) {
  const k = getKnex();
  removeSnapshots((await k('attempts').where({ assessment_id: assessment.id }).select('id')).map((x) => x.id));
  await trx(k, async (t) => {
    await t('assessments').where({ id: assessment.id }).del();
    if (assessment.page_id) await t('course_pages').where({ id: assessment.page_id }).del();
  });
}

export const assessmentOfPage = (pageId) => getKnex()('assessments').where({ page_id: pageId }).first();
