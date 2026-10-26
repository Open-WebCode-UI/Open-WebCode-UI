import { describe, it, expect, beforeEach, vi } from 'vitest';
import { freshDb, createApp, login } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { getSettings, saveSettings, NAMEID, defaults } from '../src/settings.js';
import { extractGroups, resolveIdentity, upsertSamlUser, syncRolesFromGroups, checkSamlMfa, parseAuthnStatement } from '../src/auth/saml-identity.js';
import { parseIdpMetadata, loadIdpMetadata } from '../src/auth/idp-metadata.js';
import { assertSafeUrl, isPrivateIp, safeFetchText } from '../src/net-guard.js';
import { metadataXml } from './fixtures/idp-metadata.js';

const cfg = () => ({ ...defaults.saml });
beforeEach(() => freshDb());

describe('group extraction', () => {
  it('handles string, array, custom attribute name, and the `groups` fallback', () => {
    expect(extractGroups({ memberOf: 'devs' }, 'memberOf')).toEqual(['devs']);
    expect(extractGroups({ memberOf: ['a', 'b'] }, 'memberOf')).toEqual(['a', 'b']);
    expect(extractGroups({ myGroups: ['x'] }, 'myGroups')).toEqual(['x']);
    expect(extractGroups({ groups: ['g1'] }, 'memberOf')).toEqual(['g1']); // fallback alias
    expect(extractGroups({}, 'memberOf')).toEqual([]);
  });
  it('offers both the full DN and the CN for AD memberOf values', () => {
    const g = extractGroups({ memberOf: ['CN=Developers,OU=Groups,DC=corp,DC=com', 'CN=Smith\\, Team,OU=G,DC=c'] }, 'memberOf');
    expect(g).toEqual(expect.arrayContaining(['CN=Developers,OU=Groups,DC=corp,DC=com', 'Developers', 'Smith, Team']));
  });
});

describe('identity: NameID is opaque; email/first/last come from attributes', () => {
  const attrs = { email: 'a@b.com', firstName: 'Ann', lastName: 'Lee', memberOf: ['devs'] };
  it('persistent opaque NameID is the key, not the email', () => {
    const id = resolveIdentity({ nameID: 'k3j2h1g0-opaque', nameIDFormat: NAMEID.persistent, attributes: attrs }, cfg());
    expect(id).toMatchObject({ uniqueId: 'k3j2h1g0-opaque', email: 'a@b.com', firstName: 'Ann', lastName: 'Lee' });
    expect(id.displayName).toBe('Ann Lee'); // never the NameID
  });
  it('same NameID -> same account; attributes refresh on later logins', async () => {
    const a = resolveIdentity({ nameID: 'n1', nameIDFormat: NAMEID.persistent, attributes: attrs }, cfg());
    const u1 = await upsertSamlUser('idp', a);
    const u2 = await upsertSamlUser('idp', resolveIdentity({ nameID: 'n1', attributes: { ...attrs, email: 'new@b.com', lastName: 'Kim' } }, cfg()));
    expect(u2).toBe(u1);
    expect(getDb().prepare('SELECT email, last_name FROM users WHERE id=?').get(u1)).toEqual({ email: 'new@b.com', last_name: 'Kim' });
    expect(await upsertSamlUser('other-idp', a)).not.toBe(u1);
  });
  it('resolves common claim URIs / aliases and admin-custom attribute names', () => {
    const id = resolveIdentity({ nameID: 'x', attributes: {
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'c@d.com',
      'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname': 'Cy', sn: 'Dee' } }, cfg());
    expect(id).toMatchObject({ email: 'c@d.com', firstName: 'Cy', lastName: 'Dee' });
    const custom = resolveIdentity({ nameID: 'x', attributes: { corpMail: 'z@z.com', gn: 'Z', fam: 'Y' } }, { ...cfg(), attrEmail: 'corpMail', attrFirstName: 'gn', attrLastName: 'fam' });
    expect(custom.email).toBe('z@z.com');
  });
  it('missing required attributes produce a clear error listing them', () => {
    try { resolveIdentity({ nameID: 'x', attributes: { email: 'a@b.com' } }, cfg()); throw new Error('no'); }
    catch (e) { expect(e.message).toBe('missing_attributes'); expect(e.extra.missing).toEqual(['firstName', 'lastName']); }
  });
  it('NameID is only an email fallback when it parses as an email', () => {
    expect(resolveIdentity({ nameID: 'u@x.com', attributes: { firstName: 'A', lastName: 'B' } }, cfg()).email).toBe('u@x.com');
    expect(() => resolveIdentity({ nameID: 'opaque', attributes: { firstName: 'A', lastName: 'B' } }, cfg())).toThrow(/missing_attributes/);
  });
  it('transient NameIDs require a unique-ID attribute; alternate attribute is used when configured', () => {
    expect(() => resolveIdentity({ nameID: 't-1', nameIDFormat: NAMEID.transient, attributes: attrs }, cfg())).toThrow(/transient/);
    const id = resolveIdentity({ nameID: 't-1', nameIDFormat: NAMEID.transient, attributes: { ...attrs, uid: 'jdoe' } }, { ...cfg(), uniqueIdAttribute: 'uid' });
    expect(id.uniqueId).toBe('jdoe');
  });
  it('uniqueIdAttribute "NameID" means the subject NameID, not an <Attribute>', () => {
    const c = { ...cfg(), uniqueIdAttribute: 'NameID' };
    expect(resolveIdentity({ nameID: 'abc', attributes: attrs }, c).uniqueId).toBe('abc');
    expect(() => resolveIdentity({ nameID: 't-1', nameIDFormat: NAMEID.transient, attributes: attrs }, c)).toThrow(/transient/);
  });
});

describe('group -> role mapping', () => {
  it('maps groups to roles, re-syncs on every login, and falls back to default role', async () => {
    const dev = getDb().prepare("SELECT id FROM roles WHERE name='developer'").get().id;
    const adm = getDb().prepare("SELECT id FROM roles WHERE name='administrator'").get().id;
    getDb().prepare('INSERT INTO group_role_map VALUES (?,?)').run('devs', dev);
    getDb().prepare('INSERT INTO group_role_map VALUES (?,?)').run('Admins', adm);
    const uid = await upsertSamlUser('idp', { uniqueId: 'n', email: 'a@b.com', firstName: 'A', lastName: 'B', displayName: 'A B' });
    expect((await syncRolesFromGroups(uid, ['devs', 'Admins'], cfg())).sort()).toEqual(['administrator', 'developer']);
    expect(await syncRolesFromGroups(uid, ['devs'], cfg())).toEqual(['developer']); // removed group drops the role
    expect(await syncRolesFromGroups(uid, ['nothing'], cfg())).toEqual([]); // no mapping -> no access
    expect(await syncRolesFromGroups(uid, ['nothing'], { ...cfg(), defaultRoleId: dev })).toEqual(['developer']);
  });
  it('does not touch manually assigned roles', async () => {
    const dev = getDb().prepare("SELECT id FROM roles WHERE name='developer'").get().id;
    const uid = await upsertSamlUser('idp', { uniqueId: 'n', email: 'a@b.com', firstName: 'A', lastName: 'B', displayName: 'A B' });
    getDb().prepare("INSERT INTO user_roles VALUES (?,?,'manual')").run(uid, dev);
    await syncRolesFromGroups(uid, [], cfg());
    expect(getDb().prepare('SELECT COUNT(*) c FROM user_roles WHERE user_id=?').get(uid).c).toBe(1);
  });
});

describe('SAML MFA enforcement', () => {
  const sec = { ...defaults.security };
  it('accepts configured AuthnContext classes or amr values; rejects otherwise; optional when not required', () => {
    expect(checkSamlMfa({ authnContext: 'urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken', attrs: {} }, sec, true).ok).toBe(true);
    expect(checkSamlMfa({ authnContext: 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password', attrs: { amr: ['pwd', 'MFA'] } }, sec, true).ok).toBe(true);
    const bad = checkSamlMfa({ authnContext: 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password', attrs: {} }, sec, true);
    expect(bad).toEqual({ ok: false, reasons: ['mfa_not_asserted'] });
    expect(checkSamlMfa({ authnContext: 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password', attrs: {} }, sec, false).ok).toBe(true);
  });
  it('rejects authentications older than the max age', () => {
    const r = checkSamlMfa({ authnContext: sec.samlRequiredAuthnContexts[0], authnInstant: Date.now() - 7200_000, attrs: {} }, { ...sec, samlMaxAuthAgeSec: 3600 }, true);
    expect(r.reasons).toContain('authentication_too_old');
  });
  it('extracts AuthnContextClassRef/AuthnInstant from assertion XML and refuses DTDs', () => {
    const xml = '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><saml:AuthnStatement AuthnInstant="2026-01-01T00:00:00Z"><saml:AuthnContext><saml:AuthnContextClassRef>urn:x:mfa</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion>';
    expect(parseAuthnStatement(xml)).toEqual({ authnContext: 'urn:x:mfa', authnInstant: Date.parse('2026-01-01T00:00:00Z') });
    expect(parseAuthnStatement('<!DOCTYPE x [<!ENTITY a "b">]><Assertion/>')).toEqual({});
  });
  it('skips the assertion MFA proof when the IdP is trusted to enforce MFA', () => {
    const trust = { ...sec, samlTrustIdpMfa: true };
    expect(checkSamlMfa({ authnContext: 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password', attrs: {} }, trust, true).ok).toBe(true);
    expect(checkSamlMfa({ authnInstant: Date.now() - 7200_000, attrs: {} }, { ...trust, samlMaxAuthAgeSec: 3600 }, true).reasons).toContain('authentication_too_old');
    expect(() => saveSettings('security', { ...trust, requireMfaEveryone: true, samlRequiredAuthnContexts: [], samlRequiredAmr: [] })).not.toThrow();
  });
  it('rejects MFA enforcement settings that cannot be satisfied by SAML users', () => {
    expect(() => saveSettings('security', { ...sec, requireMfaEveryone: true, samlRequiredAuthnContexts: [], samlRequiredAmr: [] })).toThrow();
  });
});

describe('IdP metadata auto-populate', () => {
  it('parses entityID, redirect SSO URL, SLO, multiple signing certs only, and NameID formats', () => {
    const md = parseIdpMetadata(metadataXml());
    expect(md).toMatchObject({ idpEntityId: 'https://idp.example.com/entity', ssoUrl: 'https://idp.example.com/sso', sloUrl: 'https://idp.example.com/slo' });
    expect(md.idpCerts).toHaveLength(2);
    expect(md.idpCerts[0]).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
    expect(md.nameIdFormats).toHaveLength(2);
  });
  it('suggests persistent when advertised, otherwise the first advertised format', () => {
    expect(parseIdpMetadata(metadataXml()).suggestedNameIdFormat).toBe(NAMEID.persistent);
    const only = parseIdpMetadata(metadataXml([NAMEID.unspecified]));
    expect(only).toMatchObject({ suggestedNameIdFormat: NAMEID.unspecified, persistentAvailable: false });
  });
  it('rejects malformed XML, DTD/XXE payloads, and non-IdP documents', () => {
    expect(() => parseIdpMetadata('<not xml')).toThrow();
    expect(() => parseIdpMetadata('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><EntityDescriptor/>')).toThrow(/dtd/);
    expect(() => parseIdpMetadata('<EntityDescriptor entityID="x"><SPSSODescriptor/></EntityDescriptor>')).toThrow(/no_idp/);
    expect(() => parseIdpMetadata('')).toThrow();
  });
  it('fetches from a URL (mocked) and from an uploaded file', async () => {
    const lookup = async () => [{ address: '93.184.216.34' }];
    const fetchImpl = vi.fn(async () => new Response(metadataXml(), { status: 200 }));
    const md = await loadIdpMetadata({ url: 'https://idp.example.com/md', fetchImpl, lookup });
    expect(md.idpEntityId).toBe('https://idp.example.com/entity');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect((await loadIdpMetadata({ xml: metadataXml() })).ssoUrl).toBe('https://idp.example.com/sso');
  });
  it('SSRF guard: https only, private/loopback/link-local blocked, oversize, and timeout rejected', async () => {
    const pub = async () => [{ address: '93.184.216.34' }];
    await expect(assertSafeUrl('http://idp.example.com/m', { lookup: pub })).rejects.toThrow(/https_required/);
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '172.16.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) expect(isPrivateIp(ip)).toBe(true);
    expect(isPrivateIp('93.184.216.34')).toBe(false);
    await expect(assertSafeUrl('https://internal.corp/m', { lookup: async () => [{ address: '10.1.1.1' }] })).rejects.toThrow(/private/);
    await expect(assertSafeUrl('https://169.254.169.254/latest', {})).rejects.toThrow(/private/);
    await expect(safeFetchText('https://idp.example.com/m', { lookup: pub, maxBytes: 100, fetchImpl: async () => new Response('x'.repeat(500)) })).rejects.toThrow(/too_large/);
    const hang = (_u, { signal }) => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))));
    await expect(safeFetchText('https://idp.example.com/m', { lookup: pub, timeoutMs: 20, fetchImpl: hang })).rejects.toThrow(/timeout/);
    // redirect to a private address is re-checked
    const redirect = async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } });
    const lookup = async (h) => [{ address: h === 'evil.example.com' ? '127.0.0.1' : '93.184.216.34' }];
    await expect(safeFetchText('https://idp.example.com/m', { lookup, fetchImpl: redirect })).rejects.toThrow(/private/);
  });
});

describe('SAML admin API', () => {
  it('preview does not save, requires idp.write, and defaults/warns on NameID format', async () => {
    const app = createApp();
    const admin = login(app, { username: 'samladmin', roles: ['administrator'] });
    const dev = login(app, { username: 'devperson' });
    expect((await dev.post('/api/admin/saml/metadata/preview').send({ xml: metadataXml() })).status).toBe(403);
    const before = getSettings('saml');
    const prev = await admin.post('/api/admin/saml/metadata/preview').send({ xml: metadataXml() });
    expect(prev.status).toBe(200); expect(prev.body.suggestedNameIdFormat).toBe(NAMEID.persistent);
    expect(getSettings('saml')).toEqual(before);
    const g = await admin.get('/api/admin/saml');
    expect(g.body.settings.nameIdFormat).toBe(NAMEID.persistent);
    expect(g.body.nameIdWarning).toBeNull();
    await admin.put('/api/admin/saml').send({ nameIdFormat: NAMEID.unspecified });
    expect((await admin.get('/api/admin/saml')).body.nameIdWarning).toMatch(/Persistent is recommended/);
    const tr = await admin.put('/api/admin/saml').send({ nameIdFormat: NAMEID.transient });
    expect(tr.status).toBe(400); expect(tr.body.error).toBe('transient_requires_unique_attribute');
    const bad = await admin.post('/api/admin/saml/metadata/preview').send({ url: 'http://127.0.0.1/md' });
    expect(bad.status).toBe(400);
  });
  it('SP metadata contains entityID, ACS URL, and NameID format; private key never exposed', async () => {
    const app = createApp();
    const admin = login(app, { username: 'samladmin', roles: ['administrator'] });
    await admin.post('/api/admin/saml/sp-cert');
    const xml = (await admin.get('/api/admin/saml/sp-metadata')).text;
    expect(xml).toContain('entityID="http://localhost:3000/auth/saml/metadata"');
    expect(xml).toContain('Location="http://localhost:3000/auth/saml/acs"');
    expect(xml).toContain(NAMEID.persistent);
    const cfg = (await admin.get('/api/admin/saml')).body;
    expect(JSON.stringify(cfg)).not.toContain('PRIVATE KEY');
    expect(cfg.settings.spPrivateKeyEnc).toBe('[set]');
    expect(getSettings('saml').spPrivateKeyEnc).toMatch(/^v1:/);
  });
});
