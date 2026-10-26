import { getKnex } from '../db/index.js';
import { userPermissions, userRoleNames } from '../auth/rbac.js';

export async function canAdminCourses(userId) { return (await userPermissions(userId)).has('course.admin'); }

// Owner, listed co-instructor, or a course admin — and the user must still hold course.author.
export async function canAuthor(userId, course) {
  const perms = await userPermissions(userId);
  if (perms.has('course.admin')) return true;
  if (!perms.has('course.author')) return false;
  return course.owner_id === userId
    || !!(await getKnex()('course_instructors').where({ course_id: course.id, user_id: userId }).first('user_id'));
}

// Enrolled directly (user), through a role the user holds, or through a SAML group from their last login.
export async function isEnrolled(userId, courseId) {
  const k = getKnex();
  const enrolled = (subjectType, subjectId) => k('course_enrollments').where({ course_id: courseId, subject_type: subjectType }).modify((q) => (Array.isArray(subjectId) ? q.whereIn('subject_id', subjectId) : q.where('subject_id', subjectId))).first('course_id');
  if (await enrolled('user', String(userId))) return true;
  const roles = await userRoleNames(userId);
  if (roles.length && await enrolled('role', roles)) return true;
  return !!(await k('course_enrollments as e').join('user_saml_groups as g', 'g.group_value', 'e.subject_id')
    .where({ 'e.course_id': courseId, 'e.subject_type': 'saml_group', 'g.user_id': userId }).first('e.course_id'));
}

export async function canLearn(userId, course) {
  return course.status === 'published' && (await userPermissions(userId)).has('course.learn') && await isEnrolled(userId, course.id);
}

export async function listLearnerCourses(userId) {
  const rows = await getKnex()('courses').where({ status: 'published' }).orderBy('title');
  const ok = await Promise.all(rows.map(async (c) => await canLearn(userId, c)));
  return rows.filter((_, i) => ok[i]);
}
