import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { getKnex } from './db/index.js';
import { insertId, trx } from './db/dialect.js';
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

export async function createLocalUser({ username, password, email = '', firstName = '', lastName = '', roles = [], isBreakGlass = false, mustChange = false }) {
  checkPassword(password, username);
  const k = getKnex();
  if (await k('users').where({ source: 'local', username }).first('id')) throw new HttpError(409, 'username_taken');
  const id = await insertId(k('users'), {
    source: 'local', username, email, first_name: firstName, last_name: lastName, display_name: `${firstName} ${lastName}`.trim() || username,
    password_hash: hashPassword(password), is_break_glass: isBreakGlass ? 1 : 0, must_change_password: mustChange ? 1 : 0,
  });
  await setUserRoles(id, roles, 'manual');
  return id;
}

export async function setUserRoles(userId, roleNames, source = 'manual') {
  const k = getKnex();
  const ids = [];
  for (const n of roleNames) {
    const role = await k('roles').where({ name: n }).first('id');
    if (!role) throw new HttpError(400, 'unknown_role', { role: n });
    ids.push(role.id);
  }
  await trx(k, async (t) => {
    await t('user_roles').where({ user_id: userId, source }).del();
    if (ids.length) await t('user_roles').insert(ids.map((role_id) => ({ user_id: userId, role_id, source }))).onConflict(['user_id', 'role_id', 'source']).ignore();
  });
}

export async function userDto(u, { withPerms = false } = {}) {
  const dto = {
    id: u.id, source: u.source, username: u.username, email: u.email, firstName: u.first_name, lastName: u.last_name,
    displayName: u.display_name || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || u.username,
    isBreakGlass: !!u.is_break_glass, disabled: !!u.disabled, mfaEnrolled: !!u.mfa_enrolled, lastLogin: u.last_login,
    mustChangePassword: !!u.must_change_password, roles: await userRoleNames(u.id),
    webauthnCount: (await getKnex()('webauthn_credentials').where({ user_id: u.id }).count({ c: '*' }).first()).c,
  };
  if (withPerms) dto.preferences = readPreferences(u);
  if (withPerms) dto.permissions = [...await userPermissions(u.id)];
  return dto;
}
