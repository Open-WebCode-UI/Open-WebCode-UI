const CERT = 'MIIC8DCCAdigAwIBAgIUXXXXXXXXXXXXXXXXXXXXXXXXXXXwDQYJKoZIhvcNAQELBQAwEjEQMA4GA1UEAwwHdGVzdC1pZHAwHhcNMjUwMTAxMDAwMDAwWhcNMzUwMTAxMDAwMDAwWjASMRAwDgYDVQQDDAd0ZXN0LWlkcDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAL';
const CERT2 = CERT.replace('XXXX', 'YYYY');
export const metadataXml = (formats = ['urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified', 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent']) => `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="https://idp.example.com/entity">
 <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
  <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${CERT}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
  <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${CERT2}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
  <md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>ZZZZ</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
  <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/slo"/>
  ${formats.map((f) => `<md:NameIDFormat>${f}</md:NameIDFormat>`).join('\n  ')}
  <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example.com/sso-post"/>
  <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/sso"/>
 </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
