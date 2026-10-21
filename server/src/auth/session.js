import { getDb } from '../db/index.js';
import { randomToken } from '../crypto.js';
import { config, cookieSecure } from '../config.js';
import { getSettings } from '../settings.js';

const now = () => Math.floor(Date.now() / 1000);
export const cookieName = () => (cookieSecure() ? '__Host-sid' : 'sid');

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createSession(userId, { stage = 'full', req, mfaSatisfied = false, stepup = false } = {}) {
  const id = randomToken(32), csrf = randomToken(24), t = now();
  getDb().prepare(`INSERT INTO sessions (id,user_id,csrf,stage,created_at,last_seen,auth_time,stepup_at,mfa_satisfied,ip,ua)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, csrf, stage, t, t, t, stepup ? t : 0, mfaSatisfied ? 1 : 0,
    req?.ip || null, (req?.get?.('user-agent') || '').slice(0, 200));
  return { id, csrf };
}

export function setSessionCookie(res, id) {
  const sec = getSettings('security');
  res.cookie(cookieName(), id, {
    httpOnly: true, secure: cookieSecure(), sameSite: 'lax', path: '/', maxAge: sec.sessionAbsoluteSec * 1000,
  });
}
export const clearSessionCookie = (res) => res.clearCookie(cookieName(), { path: '/', secure: cookieSecure(), httpOnly: true, sameSite: 'lax' });

export function revokeSession(id) { getDb().prepare('UPDATE sessions SET revoked=1 WHERE id=?').run(id); }
export function revokeUserSessions(userId, exceptId = null) {
  getDb().prepare('UPDATE sessions SET revoked=1 WHERE user_id=? AND id IS NOT ?').run(userId, exceptId);
}

// Rotate the session id (fixation defense) preserving state; returns new id/csrf.
export function rotateSession(oldId) {
  const db = getDb();
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(oldId);
  const id = randomToken(32), csrf = randomToken(24);
  db.prepare('UPDATE sessions SET revoked=1 WHERE id=?').run(oldId);
  db.prepare(`INSERT INTO sessions (id,user_id,csrf,stage,created_at,last_seen,auth_time,stepup_at,mfa_satisfied,ip,ua)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, s.user_id, csrf, s.stage, s.created_at, now(), s.auth_time, s.stepup_at, s.mfa_satisfied, s.ip, s.ua);
  return { id, csrf };
}

export function loadSession(id) {
  if (!id) return null;
  const db = getDb();
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
  if (!s || s.revoked) return null;
  const sec = getSettings('security'), t = now();
  if (t - s.last_seen > sec.sessionIdleSec || t - s.created_at > sec.sessionAbsoluteSec) {
    revokeSession(id);
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
  if (!user || user.disabled) return null;
  if (t - s.last_seen > 30) db.prepare('UPDATE sessions SET last_seen=? WHERE id=?').run(t, id);
  return { ...s, user };
}

export function sessionMiddleware(req, _res, next) {
  const sid = parseCookies(req.headers.cookie)[cookieName()];
  req.session = loadSession(sid);
  req.user = req.session?.user || null;
  next();
}

export const allowedOrigin = () => new URL(config.baseUrl).origin;
