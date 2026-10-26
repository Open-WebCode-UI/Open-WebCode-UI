import { HttpError } from '../http.js';
import { getKnex } from '../db/index.js';
import { trx, insertId } from '../db/dialect.js';
import { NAMEID } from '../settings.js';

const ALIASES = {
  email: ['email', 'mail', 'emailAddress', 'emailaddress', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', 'urn:oid:0.9.2342.19200300.100.1.3'],
  firstName: ['firstName', 'givenName', 'givenname', 'first_name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname', 'urn:oid:2.5.4.42'],
  lastName: ['lastName', 'sn', 'surname', 'last_name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname', 'urn:oid:2.5.4.4'],
  displayName: ['displayName', 'name', 'cn', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name', 'urn:oid:2.16.840.1.113730.3.1.241'],
  groups: ['memberOf', 'groups', 'http://schemas.xmlsoap.org/claims/Group', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups', 'urn:oid:1.2.840.113556.1.2.102'],
};

const flat = (v) => (v == null ? [] : Array.isArray(v) ? v.flatMap(flat) : typeof v === 'object' ? flat(v._ ?? v['#text']) : [String(v)]);

// Admin-configured attribute name first, then well-known aliases.
export function getAttr(attrs, configured, kind) {
  const names = [configured, ...(ALIASES[kind] || [])].filter(Boolean);
  for (const n of names) {
    const hit = Object.keys(attrs).find((k) => k === n) ?? Object.keys(attrs).find((k) => k.toLowerCase() === n.toLowerCase());
    if (hit !== undefined) { const v = flat(attrs[hit]).filter((s) => s !== ''); if (v.length) return v; }
  }
  return [];
}

// AD memberOf values are DNs ("CN=Devs,OU=Groups,DC=corp"). Offer both the full DN and the CN for mapping.
export function extractGroups(attrs, configured) {
  const out = new Set();
  for (const g of getAttr(attrs, configured, 'groups')) {
    const v = g.trim();
    out.add(v);
    const m = /^CN=((?:[^,\\]|\\.)+)/i.exec(v);
    if (m) out.add(m[1].replace(/\\(.)/g, '$1'));
  }
  return [...out];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function resolveIdentity(profile, cfg) {
  const attrs = profile.attributes && Object.keys(profile.attributes).length ? profile.attributes : profile;
  const nameId = profile.nameID, fmt = profile.nameIDFormat || '';
  const missing = [];
  let email = getAttr(attrs, cfg.attrEmail, 'email')[0];
  if (!email && EMAIL_RE.test(nameId || '')) email = nameId; // NameID is only a fallback when it parses as an email
  const firstName = getAttr(attrs, cfg.attrFirstName, 'firstName')[0];
  const lastName = getAttr(attrs, cfg.attrLastName, 'lastName')[0];
  if (!email) missing.push('email');
  if (!firstName) missing.push('firstName');
  if (!lastName) missing.push('lastName');
  if (missing.length) throw new HttpError(403, 'missing_attributes', { missing });
  let uniqueId = nameId;
  // "NameID" names the assertion subject, not an <Attribute>, so it falls through to the NameID path below.
  if (cfg.uniqueIdAttribute && cfg.uniqueIdAttribute.trim().toLowerCase() !== 'nameid') {
    uniqueId = getAttr(attrs, cfg.uniqueIdAttribute, '')[0];
    if (!uniqueId) throw new HttpError(403, 'missing_attributes', { missing: [cfg.uniqueIdAttribute] });
  } else if (fmt === NAMEID.transient) {
    throw new HttpError(403, 'transient_nameid_requires_unique_attribute');
  }
  if (!uniqueId) throw new HttpError(403, 'missing_nameid');
  const displayName = getAttr(attrs, cfg.attrDisplayName, 'displayName')[0] || `${firstName} ${lastName}`;
  return { uniqueId, email, firstName, lastName, displayName, groups: extractGroups(attrs, cfg.attrGroups), nameIdFormat: fmt, attrs };
}

export async function upsertSamlUser(idpEntityId, id) {
  const k = getKnex();
  const u = await k('users').where({ source: 'saml', idp_entity_id: idpEntityId, name_id: id.uniqueId }).first('id');
  const profile = { email: id.email, first_name: id.firstName, last_name: id.lastName, display_name: id.displayName };
  if (u) {
    await k('users').where({ id: u.id }).update(profile);
    return u.id;
  }
  return insertId(k('users'), { source: 'saml', ...profile, idp_entity_id: idpEntityId, name_id: id.uniqueId });
}

// Groups -> roles (re-synced at every login). Returns role names granted via SAML.
export async function syncRolesFromGroups(userId, groups, cfg) {
  const k = getKnex();
  const roleIds = new Set();
  await trx(k, async (t) => {
    await t('user_saml_groups').where({ user_id: userId }).del();
    if (groups.length) await t('user_saml_groups').insert(groups.map((g) => ({ user_id: userId, group_value: g }))).onConflict(['user_id', 'group_value']).ignore();
    if (groups.length) for (const r of await t('group_role_map').whereIn('group_value', groups).select('role_id')) roleIds.add(r.role_id);
    if (!roleIds.size && cfg.defaultRoleId) roleIds.add(cfg.defaultRoleId);
    await t('user_roles').where({ user_id: userId, source: 'saml' }).del();
    if (roleIds.size) await t('user_roles').insert([...roleIds].map((rid) => ({ user_id: userId, role_id: rid, source: 'saml' }))).onConflict(['user_id', 'role_id', 'source']).ignore();
  });
  return (await k('user_roles as ur').join('roles as r', 'r.id', 'ur.role_id').where({ 'ur.user_id': userId, 'ur.source': 'saml' }).select('r.name')).map((r) => r.name);
}

// Assertion-level MFA policy check. `ctx`: { authnContext, authnInstant (ms), attrs }.
export function checkSamlMfa(ctx, sec, required) {
  const reasons = [];
  if (required && !sec.samlTrustIdpMfa) {
    const okCtx = ctx.authnContext && sec.samlRequiredAuthnContexts.includes(ctx.authnContext);
    const amr = getAttr(ctx.attrs || {}, sec.samlAmrAttribute, '').map((s) => s.toLowerCase());
    const okAmr = sec.samlRequiredAmr.some((v) => amr.includes(v.toLowerCase()));
    if (!okCtx && !okAmr) reasons.push('mfa_not_asserted');
  }
  if (sec.samlMaxAuthAgeSec && ctx.authnInstant && (Date.now() - ctx.authnInstant) / 1000 > sec.samlMaxAuthAgeSec) reasons.push('authentication_too_old');
  return { ok: reasons.length === 0, reasons };
}

// node-saml's profile omits AuthnContext/AuthnInstant; read them from the (signature-validated) assertion XML.
import { XMLParser } from 'fast-xml-parser';
export function parseAuthnStatement(assertionXml) {
  if (!assertionXml || /<!DOCTYPE|<!ENTITY/i.test(assertionXml)) return {};
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, processEntities: false }).parse(assertionXml);
  const a = doc.Assertion || doc.Response?.Assertion;
  const st = Array.isArray(a?.AuthnStatement) ? a.AuthnStatement[0] : a?.AuthnStatement;
  const ref = st?.AuthnContext?.AuthnContextClassRef;
  const instant = st?.['@_AuthnInstant'] ? Date.parse(st['@_AuthnInstant']) : undefined;
  return { authnContext: typeof ref === 'string' ? ref.trim() : ref?.['#text']?.trim(), authnInstant: instant };
}
