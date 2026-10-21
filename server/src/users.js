import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { getDb } from './db/index.js';
import { getSettings } from './settings.js';
import { HttpError } from './http.js';
import { readPreferences } from './preferences.js';
import { userPermissions, userRoleNames } from './auth/rbac.js';

const COMMON = new Set(['password', 'password1', 'password123', '123456789012', 'qwertyuiop12', 'letmein12345', 'administrator', 'changeme1234', 'welcome12345', 'iloveyou1234']);

export function checkPassword(pw, username = '') {
  const min = getSettings('security').passwordMinLength;
  if (typeof pw !== 'string' || pw.length < min) throw new HttpError(400, 'weak_password', { message: `Password must be at least ${min} characters` });
  if (pw.length > PASSWORD_MAX) throw new HttpError(400, 'weak_password', { message: `Password must be at most ${PASSWORD_MAX} characters` });
  const l = pw.toLowerCase();
  if (COMMON.has(l) || (username && l.includes(username.toLowerCase())) || /^(.)\1+$/.test(pw))
    throw new HttpError(400, 'weak_password', { message: 'Password is too common or guessable' });
}

// Effectively unlimited (a 100k-character passphrase is far beyond any password manager); only a sanity bound against abuse.
export const PASSWORD_MAX = 100_000;
// bcrypt silently ignores everything after 72 bytes, so the password is SHA-256 pre-hashed first: every character counts,
// and NUL bytes / long inputs are safe. Stored as "bcrypt-sha256$<bcrypt hash>"; legacy plain-bcrypt hashes still verify.
const PREFIX = 'bcrypt-sha256$';
const pre = (pw) => crypto.createHash('sha256').update(String(pw), 'utf8').digest('base64');
export const hashPassword = (pw) => PREFIX + bcrypt.hashSync(pre(pw), 12);
export const isLegacyHash = (h) => !!h && !h.startsWith(PREFIX);
const DUMMY = PREFIX + bcrypt.hashSync(pre('dummy-password-for-timing'), 12);
export function verifyPassword(pw, hash) {
  const h = hash || DUMMY; // always do the work so unknown users take the same time
  const ok = h.startsWith(PREFIX) ? bcrypt.compareSync(pre(pw), h.slice(PREFIX.length)) : bcrypt.compareSync(String(pw), h);
  return ok && !!hash;
}

export function createLocalUser({ username, password, email = '', firstName = '', lastName = '', roles = [], isBreakGlass = false, mustChange = false }) {
  checkPassword(password, username);
  const db = getDb();
  if (db.prepare("SELECT 1 FROM users WHERE source='local' AND username=?").get(username))
    throw new HttpError(409, 'username_taken');
  const r = db.prepare(`INSERT INTO users (source,username,email,first_name,last_name,display_name,password_hash,is_break_glass,must_change_password)
    VALUES ('local',?,?,?,?,?,?,?,?)`).run(username, email, firstName, lastName, `${firstName} ${lastName}`.trim() || username,
    hashPassword(password), isBreakGlass ? 1 : 0, mustChange ? 1 : 0);
  const id = Number(r.lastInsertRowid);
  setUserRoles(id, roles, 'manual');
  return id;
}

export function setUserRoles(userId, roleNames, source = 'manual') {
  const db = getDb();
  db.prepare('DELETE FROM user_roles WHERE user_id=? AND source=?').run(userId, source);
  for (const n of roleNames) {
    const role = db.prepare('SELECT id FROM roles WHERE name=?').get(n);
    if (!role) throw new HttpError(400, 'unknown_role', { role: n });
    db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, source) VALUES (?,?,?)').run(userId, role.id, source);
  }
}

export function userDto(u, { withPerms = false } = {}) {
  const db = getDb();
  const dto = {
    id: u.id, source: u.source, username: u.username, email: u.email, firstName: u.first_name, lastName: u.last_name,
    displayName: u.display_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || u.username,
    isBreakGlass: !!u.is_break_glass, disabled: !!u.disabled, mfaEnrolled: !!u.mfa_enrolled, lastLogin: u.last_login,
    mustChangePassword: !!u.must_change_password, roles: userRoleNames(u.id),
    webauthnCount: db.prepare('SELECT COUNT(*) c FROM webauthn_credentials WHERE user_id=?').get(u.id).c,
  };
  if (withPerms) dto.preferences = readPreferences(u);
  if (withPerms) dto.permissions = [...userPermissions(u.id)];
  return dto;
}
