import express from 'express';
import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';
import selfsigned from 'selfsigned';
import { getKnex } from '../db/index.js';
import { insertId } from '../db/dialect.js';
import { config } from '../config.js';
import { getSettings, saveSettings } from '../settings.js';
import { randomToken, encrypt, decrypt } from '../crypto.js';
import { audit } from '../audit.js';
import { defineRoutes, fail, errorHandler } from '../http.js';
import { buildSpMetadata } from './idp-metadata.js';
import { resolveIdentity, upsertSamlUser, syncRolesFromGroups, checkSamlMfa, parseAuthnStatement } from './saml-identity.js';
import { mfaRequiredFor } from './rbac.js';
import { createSession, setSessionCookie } from './session.js';
import { rateLimit } from '../ratelimit.js';

const now = () => Math.floor(Date.now() / 1000);
export const acsUrl = () => `${config.baseUrl}/auth/saml/acs`;
export const spEntityId = (cfg) => cfg.spEntityId || `${config.baseUrl}/auth/saml/metadata`;

// Request-ID cache for InResponseTo validation, kept in the database so it survives restarts and works across instances.
const dbCache = {
  async saveAsync(key, value) {
    await getKnex()('saml_requests').insert({ id: key, value, expires: now() + 600 }).onConflict('id').merge();
    return { value, createdAt: Date.now() };
  },
  async getAsync(key) {
    const r = await getKnex()('saml_requests').where({ id: key }).where('expires', '>', now()).first('value');
    return r ? r.value : null;
  },
  async removeAsync(key) {
    if (key) await getKnex()('saml_requests').where({ id: key }).del();
    return key;
  },
};

export function buildSaml(cfg, { forceAuthn = false, sec = getSettings('security') } = {}) {
  if (!cfg.enabled || !cfg.ssoUrl || !cfg.idpCerts.length) fail(503, 'saml_not_configured');
  const opts = {
    callbackUrl: acsUrl(),
    entryPoint: cfg.ssoUrl,
    logoutUrl: cfg.sloUrl || undefined,
    issuer: spEntityId(cfg),
    audience: spEntityId(cfg),
    idpCert: cfg.idpCerts,
    idpIssuer: cfg.idpEntityId || undefined,
    identifierFormat: cfg.nameIdFormat || null,
    allowCreate: true,
    wantAssertionsSigned: cfg.wantAssertionsSigned,
    wantAuthnResponseSigned: cfg.wantResponseSigned,
    acceptedClockSkewMs: cfg.clockSkewSec * 1000,
    maxAssertionAgeMs: 5 * 60 * 1000,
    validateInResponseTo: ValidateInResponseTo.always, // binds the response to a request we issued (anti-replay / IdP-initiated blocked)
    requestIdExpirationPeriodMs: 10 * 60 * 1000,
    cacheProvider: dbCache,
    forceAuthn: forceAuthn || sec.samlForceAuthn,
    signatureAlgorithm: cfg.allowSha1 ? 'sha1' : 'sha256',
    digestAlgorithm: cfg.allowSha1 ? 'sha1' : 'sha256',
    disableRequestedAuthnContext: !(sec.samlRequiredAuthnContexts.length && (sec.requireMfaEveryone || sec.requireMfaRoles.length)),
    authnContext: sec.samlRequiredAuthnContexts,
    racComparison: 'minimum',
  };
  if (cfg.signAuthnRequests && cfg.spPrivateKeyEnc) {
    opts.privateKey = decrypt(cfg.spPrivateKeyEnc);
    opts.publicCert = cfg.spCert;
  }
  return new SAML(opts);
}

export async function generateSpCert() {
  const pems = await selfsigned.generate([{ name: 'commonName', value: new URL(config.baseUrl).hostname }], {
    days: 3650, keySize: 2048, algorithm: 'sha256',
  });
  return { cert: pems.cert, privateKeyEnc: encrypt(pems.private) };
}

export function spMetadataXml() {
  const cfg = getSettings('saml');
  return buildSpMetadata({
    entityId: spEntityId(cfg), acsUrl: acsUrl(), nameIdFormat: cfg.nameIdFormat, cert: cfg.spCert,
    signAuthnRequests: cfg.signAuthnRequests && !!cfg.spCert, wantAssertionsSigned: cfg.wantAssertionsSigned,
  });
}

export const safeRelay = (t) => (typeof t === 'string' && /^\/(?![/\\])[\w\-./?=&%#~]*$/.test(t) && !/(^|[/?#])\.\.?([/?#]|$)/.test(t) ? t : '/');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function samlRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/auth/saml');

  route.get('/metadata', 'public', (_req, res) => res.type('application/samlmetadata+xml').send(spMetadataXml()));

  route.get('/login', 'public', rateLimit('saml-login', 30, 60_000), async (req, res, next) => {
    try {
      const cfg = getSettings('saml');
      const k = getKnex();
      let target = safeRelay(req.query.relay);
      let forceAuthn = false;
      if (req.query.test === '1') {
        if (!req.session || req.session.stage !== 'full') fail(401, 'unauthenticated');
        target = '__test__';
      } else if (req.query.forceAuthn === '1' && req.session?.stage === 'full') {
        target = `stepup:${req.session.id}:${target}`; forceAuthn = true;
      }
      const state = randomToken(18);
      await k('relay_states').where('expires', '<', now()).del();
      await k('relay_states').insert({ id: state, target, expires: now() + 600 });
      const url = await buildSaml(cfg, { forceAuthn }).getAuthorizeUrlAsync(state, undefined, {});
      res.redirect(url);
    } catch (e) { next(e); }
  });

  // IdP posts cross-site, so Origin/CSRF-token checks don't apply; trust comes from signature + InResponseTo.
  route.post('/acs', 'public', { csrfExempt: true }, express.urlencoded({ extended: false, limit: '512kb' }), rateLimit('saml-acs', 60, 60_000), async (req, res, next) => {
    const cfg = getSettings('saml'), sec = getSettings('security'), k = getKnex();
    const deny = (code, extra = {}) => {
      audit(null, 'auth.saml.denied', code, { ...extra, ip: req.ip });
      res.status(403).type('html').send(`<!doctype html><meta charset=utf-8><title>Sign-in failed</title><body style="font-family:sans-serif;max-width:40em;margin:4em auto"><h2>Sign-in failed</h2><p>${escapeHtml(code)}${extra.missing ? `: ${escapeHtml(extra.missing.join(', '))}` : ''}</p><p><a href="/">Back</a></p>`);
    };
    try {
      const relay = await k('relay_states').where({ id: String(req.body.RelayState || '') }).where('expires', '>', now()).first();
      if (!relay) return deny('invalid_relay_state');
      await k('relay_states').where({ id: relay.id }).del();

      const saml = buildSaml(cfg);
      let profile;
      try { ({ profile } = await saml.validatePostResponseAsync(req.body)); }
      catch (e) { return deny('invalid_response', { error: String(e.message).slice(0, 200) }); }
      if (!profile) return deny('no_profile');

      const assertionId = profile.ID;
      if (assertionId) {
        if (await k('saml_replay').where({ id: assertionId }).first('id')) return deny('replayed_assertion');
        try { await k('saml_replay').insert({ id: assertionId, expires: now() + 3600 }); }
        catch { return deny('replayed_assertion'); } // a concurrent use of the same assertion lost the race on the primary key
        await k('saml_replay').where('expires', '<', now()).del();
      }
      let id;
      try { id = resolveIdentity(profile, cfg); }
      catch (e) { if (relay.target === '__test__') return renderTest(res, profile, null, e); return deny(e.message, e.extra); }
      const ctx = { ...parseAuthnStatement(profile.getAssertionXml?.()), attrs: profile.attributes || profile };

      if (relay.target === '__test__') return renderTest(res, profile, { id, ctx }, null);

      const uid = await upsertSamlUser(cfg.idpEntityId || profile.issuer, id);
      const user = await k('users').where({ id: uid }).first();
      if (user.disabled) return deny('account_disabled');
      const roles = await syncRolesFromGroups(uid, id.groups, cfg);
      if (!roles.length && !(await k('user_roles').where({ user_id: uid }).first('role_id'))) return deny('no_mapped_role', { groups: id.groups });

      const required = mfaRequiredFor(uid);
      const mfa = checkSamlMfa(ctx, sec, required);
      if (!mfa.ok) return deny(mfa.reasons[0], { user: uid });

      if (relay.target.startsWith('stepup:')) {
        const [, sid, ...rest] = relay.target.split(':');
        const s = await k('sessions').where({ id: sid, revoked: 0 }).first();
        if (!s || s.user_id !== uid) return deny('stepup_user_mismatch');
        await k('sessions').where({ id: sid }).update({ stepup_at: now() });
        audit(uid, 'auth.saml.stepup', null);
        return res.redirect(safeRelay(rest.join(':')));
      }
      const s = await createSession(uid, { stage: 'full', req, mfaSatisfied: required, stepup: true });
      await k('users').where({ id: uid }).update({ last_login: now() });
      setSessionCookie(res, s.id);
      audit(uid, 'auth.saml.login', null, { roles, nameIdFormat: id.nameIdFormat, authnContext: ctx.authnContext, ip: req.ip });
      res.redirect(safeRelay(relay.target));
    } catch (e) { next(e); }
  });

  r.use(errorHandler);
  return r;
}

function renderTest(res, profile, ok, err) {
  const attrs = profile.attributes || {};
  const rows = Object.entries(attrs).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(JSON.stringify(v))}</td></tr>`).join('');
  res.type('html').send(`<!doctype html><meta charset=utf-8><title>SAML test</title><body style="font-family:sans-serif;max-width:60em;margin:2em auto">
<h2>SAML test login (no session created)</h2>
<p><b>NameID:</b> ${escapeHtml(profile.nameID)} <br><b>Format:</b> ${escapeHtml(profile.nameIDFormat || '')}</p>
${err ? `<p style="color:#b00"><b>Problem:</b> ${escapeHtml(err.message)} ${escapeHtml(JSON.stringify(err.extra || {}))}</p>` : `<p><b>Resolved:</b> ${escapeHtml(JSON.stringify({ email: ok.id.email, firstName: ok.id.firstName, lastName: ok.id.lastName, groups: ok.id.groups, authnContext: ok.ctx.authnContext }))}</p>`}
<table border=1 cellpadding=4><tr><th>Attribute</th><th>Value</th></tr>${rows}</table><p><a href="/">Close</a></p>`);
}
