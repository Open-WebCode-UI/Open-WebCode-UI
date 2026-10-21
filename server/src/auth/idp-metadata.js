import { XMLParser } from 'fast-xml-parser';
import { HttpError } from '../http.js';
import { safeFetchText } from '../net-guard.js';
import { NAMEID } from '../settings.js';

const BIND = { post: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST', redirect: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect' };
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const pem = (b64) => `-----BEGIN CERTIFICATE-----\n${b64.replace(/\s+/g, '').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;

export function parseIdpMetadata(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw new HttpError(400, 'empty_metadata');
  // Never process DTDs/entities (XXE / billion-laughs).
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new HttpError(400, 'dtd_not_allowed');
  let doc;
  try {
    doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, processEntities: false, parseTagValue: false }).parse(xml);
  } catch { throw new HttpError(400, 'malformed_xml'); }
  const root = doc.EntityDescriptor ? [doc.EntityDescriptor] : arr(doc.EntitiesDescriptor?.EntityDescriptor);
  const ed = root.find((e) => e?.IDPSSODescriptor);
  if (!ed) throw new HttpError(400, 'no_idp_descriptor');
  const idp = ed.IDPSSODescriptor;
  const sso = arr(idp.SingleSignOnService), slo = arr(idp.SingleLogoutService);
  const pick = (list) => (list.find((s) => s['@_Binding'] === BIND.redirect) || list.find((s) => s['@_Binding'] === BIND.post) || list[0]);
  const certs = [];
  for (const kd of arr(idp.KeyDescriptor)) {
    if (kd['@_use'] && kd['@_use'] !== 'signing') continue;
    for (const c of arr(kd.KeyInfo?.X509Data?.X509Certificate)) {
      const v = typeof c === 'string' ? c : c?.['#text'];
      if (v && !certs.includes(pem(v))) certs.push(pem(v));
    }
  }
  const formats = arr(idp.NameIDFormat).map((f) => (typeof f === 'string' ? f : f['#text']).trim());
  if (!ed['@_entityID'] || !sso.length || !certs.length) throw new HttpError(400, 'incomplete_metadata');
  return {
    idpEntityId: ed['@_entityID'],
    ssoUrl: pick(sso)['@_Location'],
    ssoBinding: pick(sso)['@_Binding'],
    sloUrl: slo.length ? pick(slo)['@_Location'] : '',
    idpCerts: certs,
    nameIdFormats: formats,
    suggestedNameIdFormat: formats.includes(NAMEID.persistent) ? NAMEID.persistent : formats[0] || NAMEID.persistent,
    persistentAvailable: formats.includes(NAMEID.persistent) || formats.length === 0,
    wantAuthnRequestsSigned: idp['@_WantAuthnRequestsSigned'] === 'true',
  };
}

export async function loadIdpMetadata({ url, xml, allowPrivate = false, fetchImpl, lookup }) {
  if (xml) return parseIdpMetadata(xml);
  if (!url) throw new HttpError(400, 'metadata_source_required');
  const text = await safeFetchText(url, { allowPrivate, fetchImpl, lookup });
  return parseIdpMetadata(text);
}

export function buildSpMetadata({ entityId, acsUrl, sloUrl, nameIdFormat, cert, signAuthnRequests, wantAssertionsSigned }) {
  const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  const body = cert ? cert.replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, '') : '';
  const kd = (use) => body ? `<KeyDescriptor use="${use}"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${body}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></KeyDescriptor>` : '';
  return `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${esc(entityId)}">
<SPSSODescriptor AuthnRequestsSigned="${!!signAuthnRequests}" WantAssertionsSigned="${!!wantAssertionsSigned}" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
${signAuthnRequests ? kd('signing') : ''}<NameIDFormat>${esc(nameIdFormat)}</NameIDFormat>
<AssertionConsumerService Binding="${BIND.post}" Location="${esc(acsUrl)}" index="1" isDefault="true"/>
${sloUrl ? `<SingleLogoutService Binding="${BIND.redirect}" Location="${esc(sloUrl)}"/>` : ''}
</SPSSODescriptor>
</EntityDescriptor>`;
}
