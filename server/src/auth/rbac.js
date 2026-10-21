import { getDb } from '../db/index.js';
import { getSettings, coursesEnabled } from '../settings.js';

// With the Courses feature switched off, nobody holds a course permission, so every page, tab, and route that checks one disappears.
const isCoursePerm = (p) => p.startsWith('course.') || p === 'chat.course.use';

export function userPermissions(userId) {
  const rows = getDb().prepare(`SELECT DISTINCT rp.permission FROM user_roles ur
    JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id=?`).all(userId);
  const perms = rows.map((r) => r.permission);
  return new Set(coursesEnabled() ? perms : perms.filter((p) => !isCoursePerm(p)));
}

export function userRoleNames(userId) {
  return getDb().prepare(`SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=?`)
    .all(userId).map((r) => r.name);
}

export const hasPermission = (userId, perm) => userPermissions(userId).has(perm);

// Is MFA required for this user by policy? (Local accounts are always MFA-protected elsewhere.)
export function mfaRequiredFor(userId) {
  const sec = getSettings('security');
  if (sec.requireMfaEveryone) return true;
  const roles = userRoleNames(userId);
  return roles.some((r) => sec.requireMfaRoles.includes(r));
}

export function isLastAdmin(userId) {
  const db = getDb();
  const admin = db.prepare("SELECT id FROM roles WHERE name='administrator'").get();
  const admins = db.prepare(`SELECT DISTINCT u.id FROM user_roles ur JOIN users u ON u.id=ur.user_id
    WHERE ur.role_id=? AND u.disabled=0`).all(admin.id).map((r) => r.id);
  return admins.length === 1 && admins[0] === userId;
}
