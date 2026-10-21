import { getDb } from '../db/index.js';
import { nextPosition } from './outline.js';
import { removeSnapshots } from './exercises.js';

// An assessment is a page of layout 'assessment': it sits in the outline like any other page, its text is the introduction learners
// read first, and assessments.page_id points back at it (one to one). Finishing the assessment completes that page.
export const ASSESSMENT_LAYOUT = 'assessment';

export function createAssessmentPage(courseId, { moduleId = null, title, content = {}, mode = 'unlimited', passScore = null, maxAttempts = 0 }) {
  const db = getDb();
  return db.transaction(() => {
    const pageId = Number(db.prepare('INSERT INTO course_pages (course_id, module_id, position, title, layout, content_json, config_json) VALUES (?,?,?,?,?,?,?)')
      .run(courseId, moduleId, nextPosition(courseId, moduleId), title, ASSESSMENT_LAYOUT, JSON.stringify(content), '{}').lastInsertRowid);
    const id = Number(db.prepare('INSERT INTO assessments (course_id, page_id, title, mode, pass_score, max_attempts) VALUES (?,?,?,?,?,?)')
      .run(courseId, pageId, title, mode, passScore, maxAttempts).lastInsertRowid);
    return { pageId, assessmentId: id };
  })();
}

// Removes the assessment, every attempt at it (and their saved workspaces), and its page.
export function deleteAssessmentAndPage(assessment) {
  const db = getDb();
  removeSnapshots(db.prepare('SELECT id FROM attempts WHERE assessment_id=?').all(assessment.id).map((x) => x.id));
  db.transaction(() => {
    db.prepare('DELETE FROM assessments WHERE id=?').run(assessment.id);
    if (assessment.page_id) db.prepare('DELETE FROM course_pages WHERE id=?').run(assessment.page_id);
  })();
}

export const assessmentOfPage = (pageId) => getDb().prepare('SELECT * FROM assessments WHERE page_id=?').get(pageId);
