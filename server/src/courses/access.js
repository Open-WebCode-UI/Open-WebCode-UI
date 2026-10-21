import { getDb } from '../db/index.js';
import { userPermissions, userRoleNames } from '../auth/rbac.js';

export function canAdminCourses(userId) { return userPermissions(userId).has('course.admin'); }

// Owner, listed co-instructor, or a course admin — and the user must still hold course.author.
export function canAuthor(userId, course) {
  const perms = userPermissions(userId);
  if (perms.has('course.admin')) return true;
  if (!perms.has('course.author')) return false;
  return course.owner_id === userId
    || !!getDb().prepare('SELECT 1 FROM course_instructors WHERE course_id=? AND user_id=?').get(course.id, userId);
}

// Enrolled directly (user), through a role the user holds, or through a SAML group from their last login.
export function isEnrolled(userId, courseId) {
  const db = getDb();
  if (db.prepare("SELECT 1 FROM course_enrollments WHERE course_id=? AND subject_type='user' AND subject_id=?").get(courseId, String(userId))) return true;
  const roleQ = db.prepare("SELECT 1 FROM course_enrollments WHERE course_id=? AND subject_type='role' AND subject_id=?");
  if (userRoleNames(userId).some((r) => roleQ.get(courseId, r))) return true;
  return !!db.prepare(`SELECT 1 FROM course_enrollments e JOIN user_saml_groups g ON g.group_value=e.subject_id
    WHERE e.course_id=? AND e.subject_type='saml_group' AND g.user_id=?`).get(courseId, userId);
}

export function canLearn(userId, course) {
  return course.status === 'published' && userPermissions(userId).has('course.learn') && isEnrolled(userId, course.id);
}

export function listLearnerCourses(userId) {
  const rows = getDb().prepare("SELECT * FROM courses WHERE status='published' ORDER BY title").all();
  return rows.filter((c) => canLearn(userId, c));
}
