import { getKnex } from '../db/index.js';
import { getSettings, coursesEnabled } from '../settings.js';

// With the Courses feature switched off, nobody holds a course permission, so every page, tab, and route that checks one disappears.
const isCoursePerm = (p) => p.startsWith('course.') || p === 'chat.course.use';

export async function userPermissions(userId) {
  const rows = await getKnex()('user_roles as ur').join('role_permissions as rp', 'rp.role_id', 'ur.role_id').where('ur.user_id', userId).distinct('rp.permission');
  const perms = rows.map((r) => r.permission);
  return new Set(coursesEnabled() ? perms : perms.filter((p) => !isCoursePerm(p)));
}

export async function userRoleNames(userId) {
  return (await getKnex()('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id').where('ur.user_id', userId).select('r.name')).map((r) => r.name);
}

export const hasPermission = async (userId, perm) => (await userPermissions(userId)).has(perm);

// Is MFA required for this user by policy? (Local accounts are always MFA-protected elsewhere.)
export async function mfaRequiredFor(userId) {
  const sec = getSettings('security');
  if (sec.requireMfaEveryone) return true;
  const roles = await userRoleNames(userId);
  return roles.some((r) => sec.requireMfaRoles.includes(r));
}

export async function isLastAdmin(userId) {
  const k = getKnex();
  const admin = await k('roles').where({ name: 'administrator' }).first('id');
  const admins = (await k('user_roles as ur').join('users as u', 'u.id', 'ur.user_id').where({ 'ur.role_id': admin.id, 'u.disabled': 0 }).distinct('u.id')).map((r) => r.id);
  return admins.length === 1 && admins[0] === userId;
}
