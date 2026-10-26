import { getKnex } from '../db/index.js';
import { trx } from '../db/dialect.js';
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

export async function createSession(userId, { stage = 'full', req, mfaSatisfied = false, stepup = false } = {}) {
  const id = randomToken(32), csrf = randomToken(24), t = now();
  await getKnex()('sessions').insert({
    id, user_id: userId, csrf, stage, created_at: t, last_seen: t, auth_time: t, stepup_at: stepup ? t : 0, mfa_satisfied: mfaSatisfied ? 1 : 0,
    ip: req?.ip || null, ua: (req?.get?.('user-agent') || '').slice(0, 200),
  });
  return { id, csrf };
}

export function setSessionCookie(res, id) {
  const sec = getSettings('security');
  res.cookie(cookieName(), id, {
    httpOnly: true, secure: cookieSecure(), sameSite: 'lax', path: '/', maxAge: sec.sessionAbsoluteSec * 1000,
  });
}
export const clearSessionCookie = (res) => res.clearCookie(cookieName(), { path: '/', secure: cookieSecure(), httpOnly: true, sameSite: 'lax' });

export async function revokeSession(id) { await getKnex()('sessions').where({ id }).update({ revoked: 1 }); }
export async function revokeUserSessions(userId, exceptId = null) {
  await getKnex()('sessions').where({ user_id: userId }).modify((q) => { if (exceptId != null) q.whereNot({ id: exceptId }); }).update({ revoked: 1 });
}

// Rotate the session id (fixation defense) preserving state; returns new id/csrf.
export async function rotateSession(oldId) {
  const k = getKnex();
  const s = await k('sessions').where({ id: oldId }).first();
  const id = randomToken(32), csrf = randomToken(24);
  await trx(k, async (t) => {
    await t('sessions').where({ id: oldId }).update({ revoked: 1 });
    await t('sessions').insert({
      id, user_id: s.user_id, csrf, stage: s.stage, created_at: s.created_at, last_seen: now(), auth_time: s.auth_time, stepup_at: s.stepup_at, mfa_satisfied: s.mfa_satisfied, ip: s.ip, ua: s.ua,
    });
  });
  return { id, csrf };
}

export async function loadSession(id) {
  if (!id) return null;
  const k = getKnex();
  const s = await k('sessions').where({ id }).first();
  if (!s || s.revoked) return null;
  const sec = getSettings('security'), t = now();
  if (t - s.last_seen > sec.sessionIdleSec || t - s.created_at > sec.sessionAbsoluteSec) {
    await revokeSession(id);
    return null;
  }
  const user = await k('users').where({ id: s.user_id }).first();
  if (!user || user.disabled) return null;
  if (t - s.last_seen > 30) await k('sessions').where({ id }).update({ last_seen: t });
  return { ...s, user };
}

export async function sessionMiddleware(req, _res, next) {
  const sid = parseCookies(req.headers.cookie)[cookieName()];
  try {
    req.session = await loadSession(sid);
    req.user = req.session?.user || null;
  } catch (e) { return next(e); }
  next();
}

export const allowedOrigin = () => new URL(config.baseUrl).origin;
