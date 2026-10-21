import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import zlib from 'node:zlib';
import selfsigned from 'selfsigned';
import { SignedXml } from 'xml-crypto';
import { freshDb, createApp, request } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { saveSettings, getSettings, NAMEID } from '../src/settings.js';

const SP = 'http://localhost:3000/auth/saml/metadata', ACS = 'http://localhost:3000/auth/saml/acs', IDP = 'https://idp.example.com/entity';
const MFA_CTX = 'urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken', PW_CTX = 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport';
let idpKey, otherKey, app;
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();

beforeAll(async () => {
  idpKey = await selfsigned.generate([{ name: 'commonName', value: 'idp' }], { days: 30, keySize: 2048, algorithm: 'sha256' });
  otherKey = await selfsigned.generate([{ name: 'commonName', value: 'evil' }], { days: 30, keySize: 2048, algorithm: 'sha256' });
});
beforeEach(() => {
  freshDb(); app = createApp();
  saveSettings('saml', { ...getSettings('saml'), enabled: true, ssoUrl: 'https://idp.example.com/sso', idpEntityId: IDP, idpCerts: [idpKey.cert] });
  const dev = getDb().prepare("SELECT id FROM roles WHERE name='developer'").get().id;
  const adm = getDb().prepare("SELECT id FROM roles WHERE name='administrator'").get().id;
  getDb().prepare('INSERT INTO group_role_map VALUES (?,?)').run('devs', dev);
  getDb().prepare('INSERT INTO group_role_map VALUES (?,?)').run('CN=Admins,OU=G,DC=c', adm);
});

async function startLogin(query = '') {
  const res = await request(app).get(`/auth/saml/login${query}`);
  expect(res.status).toBe(302);
  const url = new URL(res.headers.location);
  const req = zlib.inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest'), 'base64')).toString();
  return { url, req, id: /ID="([^"]+)"/.exec(req)[1], relay: url.searchParams.get('RelayState') };
}

function buildResponse({ inResponseTo, nameId = 'opaque-persistent-id', format = NAMEID.persistent, attrs, authnContext = PW_CTX, audience = SP, key = idpKey, sign = true, tamper, assertionId = `_a${Math.random().toString(36).slice(2)}`, notOnOrAfter = iso(300_000) }) {
  attrs = attrs ?? { email: 'ann@example.com', firstName: 'Ann', lastName: 'Lee', memberOf: ['devs'] };
  const attrXml = Object.entries(attrs).map(([k, v]) => `<saml:Attribute Name="${k}">${[].concat(v).map((x) => `<saml:AttributeValue>${x}</saml:AttributeValue>`).join('')}</saml:Attribute>`).join('');
  let assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${iso()}"><saml:Issuer>${IDP}</saml:Issuer><saml:Subject><saml:NameID Format="${format}">${nameId}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${ACS}" InResponseTo="${inResponseTo}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${notOnOrAfter}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${iso(-1000)}" SessionIndex="_s1"><saml:AuthnContext><saml:AuthnContextClassRef>${authnContext}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement>${attrXml}</saml:AttributeStatement></saml:Assertion>`;
  if (sign) {
    const sig = new SignedXml({ privateKey: key.private, publicCert: key.cert, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
    sig.addReference({ xpath: "//*[local-name(.)='Assertion']", transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
    sig.computeSignature(assertion, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
    assertion = sig.getSignedXml();
  }
  if (tamper) assertion = tamper(assertion);
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${Math.random().toString(36).slice(2)}" Version="2.0" IssueInstant="${iso()}" Destination="${ACS}" InResponseTo="${inResponseTo}"><saml:Issuer>${IDP}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`;
  return Buffer.from(xml).toString('base64');
}
const post = (SAMLResponse, RelayState) => request(app).post('/auth/saml/acs').type('form').send({ SAMLResponse, RelayState });

describe('SAML SP flow (locally signed assertions)', () => {
  it('AuthnRequest asks for the persistent NameID format by default, with AllowCreate', async () => {
    const { req, url } = await startLogin();
    expect(url.origin + url.pathname).toBe('https://idp.example.com/sso');
    expect(req).toContain(`Format="${NAMEID.persistent}"`); expect(req).toContain('AllowCreate="true"');
    expect(req).toContain(`<saml:Issuer`); expect(req).toContain(SP);
  });
  it('honors an administrator-chosen NameID format', async () => {
    saveSettings('saml', { ...getSettings('saml'), nameIdFormat: NAMEID.unspecified });
    expect((await startLogin()).req).toContain(`Format="${NAMEID.unspecified}"`);
  });
  it('logs in with an opaque persistent NameID, JIT-provisions the user, and maps groups to roles', async () => {
    const { id, relay } = await startLogin('?relay=/projects');
    const res = await post(buildResponse({ inResponseTo: id }), relay);
    expect(res.status).toBe(302); expect(res.headers.location).toBe('/projects');
    expect(res.headers['set-cookie'][0]).toMatch(/^sid=.*HttpOnly.*SameSite=Lax/i);
    const u = getDb().prepare("SELECT * FROM users WHERE source='saml'").get();
    expect(u).toMatchObject({ name_id: 'opaque-persistent-id', email: 'ann@example.com', first_name: 'Ann', last_name: 'Lee', idp_entity_id: IDP });
    const cookie = res.headers['set-cookie'][0].split(';')[0];
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.body.user.roles).toEqual(['developer']);
    expect(me.body.user.displayName).toBe('Ann Lee');
  });
  it('accepts non-email NameID formats (unspecified) too', async () => {
    const { id, relay } = await startLogin();
    const res = await post(buildResponse({ inResponseTo: id, nameId: 'jdoe', format: NAMEID.unspecified }), relay);
    expect(res.status).toBe(302);
    expect(getDb().prepare("SELECT name_id FROM users WHERE source='saml'").get().name_id).toBe('jdoe');
  });
  it('denies logins missing required attributes, with a clear message', async () => {
    const { id, relay } = await startLogin();
    const res = await post(buildResponse({ inResponseTo: id, attrs: { email: 'a@b.com', memberOf: 'devs' } }), relay);
    expect(res.status).toBe(403); expect(res.text).toContain('missing_attributes'); expect(res.text).toContain('firstName, lastName');
  });
  it('denies users with no mapped group', async () => {
    const { id, relay } = await startLogin();
    const res = await post(buildResponse({ inResponseTo: id, attrs: { email: 'a@b.com', firstName: 'A', lastName: 'B', memberOf: 'nobody' } }), relay);
    expect(res.status).toBe(403); expect(res.text).toContain('no_mapped_role');
  });
  it('rejects unsigned, wrongly-signed, tampered, wrong-audience, and expired assertions', async () => {
    const cases = {
      unsigned: { sign: false },
      wrongKey: { key: otherKey },
      tampered: { tamper: (x) => x.replace('opaque-persistent-id', 'admin-victim') },
      audience: { audience: 'https://other-sp.example.com' },
      expired: { notOnOrAfter: iso(-3600_000) },
    };
    for (const [name, opts] of Object.entries(cases)) {
      const { id, relay } = await startLogin();
      const res = await post(buildResponse({ inResponseTo: id, ...opts }), relay);
      expect(res.status, name).toBe(403);
      expect(res.headers['set-cookie'], name).toBeUndefined();
    }
    expect(getDb().prepare("SELECT COUNT(*) c FROM users WHERE source='saml'").get().c).toBe(0);
  });
  it('rejects replays, unsolicited (IdP-initiated) responses and forged RelayState', async () => {
    const { id, relay } = await startLogin();
    const resp = buildResponse({ inResponseTo: id });
    expect((await post(resp, relay)).status).toBe(302);
    expect((await post(resp, relay)).status).toBe(403); // relay state is single-use
    const second = await startLogin();
    expect((await post(resp, second.relay)).status).toBe(403); // replayed response against a new request
    expect((await post(buildResponse({ inResponseTo: 'ID_never_issued' }), (await startLogin()).relay)).status).toBe(403);
    expect((await post(buildResponse({ inResponseTo: id }), 'forged-state')).status).toBe(403);
  });
  it('blocks open redirects via relay', async () => {
    for (const evil of ['//evil.com', 'https://evil.com', '/\\evil.com']) {
      const { id, relay } = await startLogin(`?relay=${encodeURIComponent(evil)}`);
      const res = await post(buildResponse({ inResponseTo: id }), relay);
      expect(res.headers.location).toBe('/');
      getDb().prepare("DELETE FROM users WHERE source='saml'").run();
    }
  });
  it('enforces IdP-side MFA for roles that require it (administrators by default)', async () => {
    const attrs = { email: 'root@example.com', firstName: 'Root', lastName: 'User', memberOf: ['CN=Admins,OU=G,DC=c'] };
    let { id, relay } = await startLogin();
    let res = await post(buildResponse({ inResponseTo: id, attrs, authnContext: PW_CTX }), relay);
    expect(res.status).toBe(403); expect(res.text).toContain('mfa_not_asserted');
    ({ id, relay } = await startLogin());
    res = await post(buildResponse({ inResponseTo: id, attrs, authnContext: MFA_CTX }), relay);
    expect(res.status).toBe(302);
    ({ id, relay } = await startLogin());
    res = await post(buildResponse({ inResponseTo: id, attrs: { ...attrs, amr: ['pwd', 'mfa'] }, authnContext: PW_CTX }), relay);
    expect(res.status).toBe(302); // amr attribute satisfies policy
  });
  it('MFA policy is not applied to roles that do not require it, but is when required for everyone', async () => {
    let { id, relay } = await startLogin();
    expect((await post(buildResponse({ inResponseTo: id }), relay)).status).toBe(302); // developer, no MFA needed
    saveSettings('security', { ...getSettings('security'), requireMfaEveryone: true });
    ({ id, relay } = await startLogin());
    expect((await post(buildResponse({ inResponseTo: id }), relay)).status).toBe(403);
  });
  it('test-login dry run shows attributes without creating a session or user', async () => {
    const { login } = await import('./helpers.js');
    const admin = login(app, { username: 'samladmin', roles: ['administrator'] });
    const res = await request(app).get('/auth/saml/login?test=1').set('Cookie', admin.cookie);
    const url = new URL(res.headers.location);
    const id = /ID="([^"]+)"/.exec(zlib.inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest'), 'base64')).toString())[1];
    const out = await post(buildResponse({ inResponseTo: id }), url.searchParams.get('RelayState'));
    expect(out.status).toBe(200); expect(out.text).toContain('no session created'); expect(out.text).toContain('ann@example.com');
    expect(out.headers['set-cookie']).toBeUndefined();
    expect(getDb().prepare("SELECT COUNT(*) c FROM users WHERE source='saml'").get().c).toBe(0);
    expect((await request(app).get('/auth/saml/login?test=1')).status).toBe(401); // anonymous cannot start a test
  });
});
