import express from 'express';
import * as webauthn from '@simplewebauthn/server';
import { getKnex } from '../db/index.js';
import { config } from '../config.js';
import { defineRoutes, fail, validate, z, stepupOk } from '../http.js';
import { getSettings } from '../settings.js';
import { audit } from '../audit.js';
import { rateLimit, hit } from '../ratelimit.js';
import { createSession, setSessionCookie, clearSessionCookie, revokeSession, rotateSession, revokeUserSessions } from '../auth/session.js';
import { verifyPassword, userDto, checkPassword, hashPassword, isLegacyHash, PASSWORD_MAX } from '../users.js';
import { listLearnerCourses } from '../courses/access.js';
import { beginTotp, confirmTotp, verifySecondFactor, enrollmentRequired } from '../auth/mfa.js';

const now = () => Math.floor(Date.now() / 1000);
const rp = () => ({ rpID: new URL(config.baseUrl).hostname, origin: new URL(config.baseUrl).origin });
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function authRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/api/auth');

  route.get('/me', 'partial', async (req, res) => {
    const full = req.session.stage === 'full';
    const user = await userDto(req.user, { withPerms: full });
    // Lets the navbar hide Courses from learners who have nothing to take.
    if (full && user) user.hasCourses = (await listLearnerCourses(req.user.id)).length > 0;
    res.json({ stage: req.session.stage, csrf: req.session.csrf, user, stepup: stepupOk(req) });
  });

  route.post('/local/login', 'public', rateLimit('login', 20, 60_000), async (req, res) => {
    const { username, password } = validate(z.object({ username: z.string().max(200), password: z.string().max(PASSWORD_MAX) }), req.body);
    const sec = getSettings('security');
    const k = getKnex();
    const generic = () => res.status(401).json({ error: 'invalid_credentials' });
    if (!sec.localLoginEnabled) return generic();
    if (!hit(`login-user:${username.toLowerCase()}`, 30, 15 * 60_000)) return res.status(429).json({ error: 'rate_limited' });
    const u = await k('users').where({ source: 'local', username }).first();
    const ok = verifyPassword(password, u?.password_hash); // constant-ish time even for unknown users
    const t = now();
    if (!u || u.disabled || (sec.breakGlassOnly && !u.is_break_glass) || u.locked_until > t) {
      await audit(u?.id ?? null, 'auth.local.denied', username, { reason: !u ? 'unknown' : u.locked_until > t ? 'locked' : 'policy', ip: req.ip });
      return generic();
    }
    if (!ok) {
      const fails = u.failed_attempts + 1;
      if (fails >= sec.lockoutThreshold) {
        const secs = Math.min(sec.lockoutMinutes * 60 * 2 ** u.lockouts, 86400);
        await k('users').where({ id: u.id }).update({ failed_attempts: 0, lockouts: k.raw('lockouts + 1'), locked_until: t + secs });
        await audit(u.id, 'auth.local.locked', username, { seconds: secs });
      } else await k('users').where({ id: u.id }).update({ failed_attempts: fails });
      await audit(u.id, 'auth.local.failed', username, { ip: req.ip });
      return generic();
    }
    await k('users').where({ id: u.id }).update({ failed_attempts: 0, lockouts: 0, locked_until: 0 });
    if (isLegacyHash(u.password_hash)) await k('users').where({ id: u.id }).update({ password_hash: hashPassword(password) }); // upgrade old hashes
    // Local accounts always require a second factor; enrollment is forced before any privileges.
    const stage = u.mfa_enrolled ? 'mfa' : enrollmentRequired(u) ? 'enroll' : 'full';
    const s = await createSession(u.id, { stage, req, mfaSatisfied: false, stepup: stage === 'full' });
    if (stage === 'full') await k('users').where({ id: u.id }).update({ last_login: t });
    setSessionCookie(res, s.id);
    await audit(u.id, 'auth.local.password_ok', username, { stage, ip: req.ip, breakGlass: !!u.is_break_glass });
    res.json({ stage, csrf: s.csrf });
  });

  route.post('/mfa/verify', 'partial', rateLimit('mfa', 20, 60_000), async (req, res) => {
    if (req.session.stage !== 'mfa') fail(400, 'not_pending');
    const { code } = validate(z.object({ code: z.string().max(32) }), req.body);
    const how = await verifySecondFactor(req.user.id, code.trim());
    if (!how) {
      await audit(req.user.id, 'auth.mfa.failed', req.user.username, { ip: req.ip });
      if (!hit(`mfa-fail:${req.user.id}`, 5, 15 * 60_000)) { await revokeSession(req.session.id); fail(429, 'too_many_attempts'); }
      fail(401, 'invalid_code');
    }
    return completeMfa(req, res, how);
  });

  async function completeMfa(req, res, how) {
    const k = getKnex(), t = now();
    await k('sessions').where({ id: req.session.id }).update({ stage: 'full', mfa_satisfied: 1, stepup_at: t });
    const s = await rotateSession(req.session.id);
    await k('users').where({ id: req.user.id }).update({ last_login: t });
    setSessionCookie(res, s.id);
    await audit(req.user.id, 'auth.mfa.ok', req.user.username, { method: how });
    res.json({ stage: 'full', csrf: s.csrf });
  }

  route.post('/mfa/totp/setup', 'partial', async (req, res) => {
    if (req.session.stage === 'mfa') fail(403, 'forbidden');
    if (req.session.stage === 'full' && req.user.mfa_enrolled && !stepupOk(req)) fail(403, 'mfa_required', { stepup: true, method: 'local' });
    if (req.user.source !== 'local') fail(400, 'saml_users_use_idp_mfa');
    const out = await beginTotp(req.user, getSettings('general').appName);
    res.json(out);
  });

  route.post('/mfa/totp/confirm', 'partial', async (req, res) => {
    if (req.session.stage === 'mfa') fail(403, 'forbidden');
    const { code } = validate(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
    const codes = await confirmTotp(req.user.id, code);
    if (!codes) fail(400, 'invalid_code');
    await audit(req.user.id, 'auth.mfa.enrolled', req.user.username, { method: 'totp' });
    const wasEnroll = req.session.stage === 'enroll';
    let csrf = req.session.csrf;
    if (wasEnroll) {
      await getKnex()('sessions').where({ id: req.session.id }).update({ stage: 'full', mfa_satisfied: 1, stepup_at: now() });
      const s = await rotateSession(req.session.id); setSessionCookie(res, s.id); csrf = s.csrf;
      await getKnex()('users').where({ id: req.user.id }).update({ last_login: now() });
    }
    res.json({ recoveryCodes: codes, stage: 'full', csrf });
  });

  // ---- WebAuthn / passkeys
  route.post('/mfa/webauthn/register/options', 'partial', async (req, res) => {
    if (req.session.stage === 'mfa') fail(403, 'forbidden');
    if (req.user.mfa_enrolled && req.session.stage === 'full' && !stepupOk(req)) fail(403, 'mfa_required', { stepup: true, method: 'local' });
    const creds = await getKnex()('webauthn_credentials').where({ user_id: req.user.id }).select('credential_id');
    const opts = await webauthn.generateRegistrationOptions({
      rpName: getSettings('general').appName, rpID: rp().rpID, userName: req.user.username || req.user.email || String(req.user.id),
      userID: new TextEncoder().encode(String(req.user.id)), attestationType: 'none',
      excludeCredentials: creds.map((c) => ({ id: c.credential_id })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    await getKnex()('sessions').where({ id: req.session.id }).update({ webauthn_challenge: opts.challenge });
    res.json(opts);
  });

  route.post('/mfa/webauthn/register/verify', 'partial', async (req, res) => {
    if (req.session.stage === 'mfa') fail(403, 'forbidden');
    const v = await webauthn.verifyRegistrationResponse({
      response: req.body, expectedChallenge: req.session.webauthn_challenge, expectedOrigin: rp().origin, expectedRPID: rp().rpID,
    }).catch(() => null);
    if (!v?.verified) fail(400, 'webauthn_failed');
    const c = v.registrationInfo.credential;
    await getKnex()('webauthn_credentials').insert({
      user_id: req.user.id, credential_id: c.id, public_key: b64u(c.publicKey), counter: c.counter, transports: JSON.stringify(c.transports || []), name: String(req.body?.name || 'Passkey').slice(0, 60),
    });
    await getKnex()('users').where({ id: req.user.id }).update({ mfa_enrolled: 1 });
    await audit(req.user.id, 'auth.mfa.enrolled', req.user.username, { method: 'webauthn' });
    let csrf = req.session.csrf;
    if (req.session.stage === 'enroll') {
      await getKnex()('sessions').where({ id: req.session.id }).update({ stage: 'full', mfa_satisfied: 1, stepup_at: now() });
      const s = await rotateSession(req.session.id); setSessionCookie(res, s.id); csrf = s.csrf;
    }
    res.json({ ok: true, stage: 'full', csrf });
  });

  route.post('/mfa/webauthn/authenticate/options', 'partial', async (req, res) => {
    const creds = await getKnex()('webauthn_credentials').where({ user_id: req.user.id }).select('credential_id', 'transports');
    if (!creds.length) fail(400, 'no_credentials');
    const opts = await webauthn.generateAuthenticationOptions({
      rpID: rp().rpID, userVerification: 'preferred',
      allowCredentials: creds.map((c) => ({ id: c.credential_id, transports: JSON.parse(c.transports) })),
    });
    await getKnex()('sessions').where({ id: req.session.id }).update({ webauthn_challenge: opts.challenge });
    res.json(opts);
  });

  route.post('/mfa/webauthn/authenticate/verify', 'partial', async (req, res) => {
    const row = await getKnex()('webauthn_credentials').where({ user_id: req.user.id, credential_id: String(req.body?.id) }).first();
    if (!row) fail(400, 'unknown_credential');
    const v = await webauthn.verifyAuthenticationResponse({
      response: req.body, expectedChallenge: req.session.webauthn_challenge, expectedOrigin: rp().origin, expectedRPID: rp().rpID,
      credential: { id: row.credential_id, publicKey: Buffer.from(row.public_key, 'base64url'), counter: row.counter, transports: JSON.parse(row.transports) },
    }).catch(() => null);
    if (!v?.verified) { await audit(req.user.id, 'auth.mfa.failed', req.user.username, { method: 'webauthn' }); fail(401, 'webauthn_failed'); }
    await getKnex()('webauthn_credentials').where({ id: row.id }).update({ counter: v.authenticationInfo.newCounter });
    if (req.session.stage === 'mfa') return completeMfa(req, res, 'webauthn');
    await getKnex()('sessions').where({ id: req.session.id }).update({ stepup_at: now() });
    res.json({ ok: true, stage: req.session.stage });
  });

  // Step-up re-verification for sensitive actions (local users: second factor; SAML users: IdP re-auth).
  route.post('/stepup', 'authenticated', rateLimit('stepup', 20, 60_000), async (req, res) => {
    if (req.user.source === 'saml') return res.json({ reauth: `/auth/saml/login?forceAuthn=1&relay=${encodeURIComponent('/')}` });
    const { code } = validate(z.object({ code: z.string().max(32) }), req.body);
    if (!(await verifySecondFactor(req.user.id, code.trim()))) {
      await audit(req.user.id, 'auth.stepup.failed', req.user.username);
      fail(401, 'invalid_code');
    }
    await getKnex()('sessions').where({ id: req.session.id }).update({ stepup_at: now() });
    res.json({ ok: true });
  });

  route.post('/logout', 'partial', async (req, res) => {
    await revokeSession(req.session.id);
    clearSessionCookie(res);
    await audit(req.user.id, 'auth.logout', req.user.username);
    res.json({ ok: true });
  });

  route.post('/password', 'authenticated', { allowPasswordChange: true }, async (req, res) => {
    if (req.user.source !== 'local') fail(400, 'not_local');
    const { current, next } = validate(z.object({ current: z.string().max(PASSWORD_MAX), next: z.string().max(PASSWORD_MAX) }), req.body);
    if (!verifyPassword(current, req.user.password_hash)) fail(401, 'invalid_credentials');
    checkPassword(next, req.user.username);
    await getKnex()('users').where({ id: req.user.id }).update({ password_hash: hashPassword(next), must_change_password: 0 });
    await revokeUserSessions(req.user.id, req.session.id);
    await audit(req.user.id, 'auth.password.changed', req.user.username);
    res.json({ ok: true });
  });

  route.get('/sessions', 'authenticated', async (req, res) => {
    const rows = await getKnex()('sessions').where({ user_id: req.user.id, revoked: 0 }).orderBy('last_seen', 'desc').select('id', 'created_at', 'last_seen', 'ip', 'ua');
    res.json(rows.map((s) => ({ ...s, id: s.id.slice(0, 8), current: s.id === req.session.id })));
  });
  route.post('/sessions/revoke-all', 'authenticated', async (req, res) => {
    await revokeUserSessions(req.user.id, req.session.id);
    await audit(req.user.id, 'auth.sessions.revoked_all', req.user.username);
    res.json({ ok: true });
  });

  return r;
}
