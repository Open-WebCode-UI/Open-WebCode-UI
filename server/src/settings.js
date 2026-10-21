import { z } from 'zod';
import { getDb } from './db/index.js';

const shellDefaults = { timeoutSec: 60, outputCapBytes: 100_000 };

// What a tutor panel can show beside the chat. The administrator decides which of these exist; an instructor picks from the enabled ones per page.
export const SUBPANEL_TYPES = ['notes', 'hints', 'resources', 'progress'];

export const schemas = {
  courses: z.object({
    allowedModelIds: z.array(z.number().int()).max(500).nullable().default(null), // models instructors may choose for a course; null = any model they can use
    subpanels: z.array(z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/), label: z.string().trim().min(1).max(40),
      type: z.enum(SUBPANEL_TYPES), enabled: z.boolean(),
    })).max(20).refine((a) => new Set(a.map((x) => x.id)).size === a.length, 'duplicate subpanel id'),
  }),
  general: z.object({
    appName: z.string().min(1).max(80),
    tagline: z.string().max(200),
    aiDisclaimer: z.string().trim().max(300),
    contactName: z.string().max(120),
    contactEmail: z.union([z.literal(''), z.email()]),
    helpdeskEmail: z.union([z.literal(''), z.email()]),
    helpdeskPhone: z.string().max(60),
    helpdeskUrl: z.union([z.literal(''), z.url().refine((u) => /^https?:\/\//i.test(u), 'must be http(s)')]),
    helpdeskHours: z.string().max(120),
    supportMessage: z.string().max(1000),
    loginBanner: z.string().max(2000),
    termsNotice: z.string().max(4000),
    maxUploadMb: z.number().int().min(1).max(500),
    maxAttachmentMb: z.number().int().min(1).max(50),
    memoryAllowed: z.boolean(),
    coursesEnabled: z.boolean(), // off: the Courses feature is hidden and refused everywhere (see auth/rbac.js and app.js)
    webSearchAllowed: z.boolean(),
    userMcpAllowed: z.boolean(),
    execMode: z.enum(['files_only', 'workspace_shell']),
    shellTimeoutSec: z.number().int().min(1).max(600),
    shellOutputCapBytes: z.number().int().min(1000).max(5_000_000),
    maxAgentIterations: z.number().int().min(1).max(100),
    showSessionCost: z.boolean(),
    showModelPricing: z.boolean(),
    funMode: z.boolean(),
    secretGlobs: z.array(z.string().max(100)).max(100),
    defaultModels: z.object({
      plan: z.number().int().nullable(), act: z.number().int().nullable(), chat: z.number().int().nullable(),
    }),
  }),
  branding: z.object({
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    colorMode: z.enum(['manual', 'auto']), // auto: the other brand colors are derived from primaryColor in the browser
    primaryColorDark: z.string().regex(/^#[0-9a-fA-F]{6}$/), // primary used in dark mode
    secondaryColorLight: z.string().regex(/^#[0-9a-fA-F]{6}$/), // secondary used in light mode
    buttonTextLight: z.string().regex(/^#[0-9a-fA-F]{6}$/), // text on colored buttons, light mode
    buttonTextDark: z.string().regex(/^#[0-9a-fA-F]{6}$/), // text on colored buttons, dark mode
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    surfaceColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    defaultMode: z.enum(['system', 'light', 'dark']),
    fontFamily: z.string().max(200).regex(/^[\w\s,'"\-]+$/),
    fontUrl: z.union([z.literal(''), z.url().refine((u) => u.startsWith('https://'))]),
    borderRadius: z.number().int().min(0).max(32),
    density: z.enum(['comfortable', 'compact']),
    monacoTheme: z.enum(['system', 'vs', 'vs-dark', 'hc-black']),
    loginText: z.string().max(2000),
    personaName: z.string().trim().max(60),
    logoDataUrl: z.string().max(700_000),
    faviconDataUrl: z.string().max(200_000),
  }),
  security: z.object({
    requireMfaEveryone: z.boolean(),
    requireMfaRoles: z.array(z.string()),
    samlRequiredAuthnContexts: z.array(z.string()),
    samlRequiredAmr: z.array(z.string()),
    samlAmrAttribute: z.string().max(200),
    samlTrustIdpMfa: z.boolean(), // IdP doesn't send proof of MFA: trust it to enforce MFA (only honoured while SAML is enabled)
    samlMaxAuthAgeSec: z.number().int().min(0).max(86400 * 7),
    samlForceAuthn: z.boolean(),
    mfaGraceDays: z.number().int().min(0).max(90),
    stepupWindowSec: z.number().int().min(30).max(3600),
    sessionIdleSec: z.number().int().min(60).max(86400),
    sessionAbsoluteSec: z.number().int().min(300).max(86400 * 30),
    localLoginEnabled: z.boolean(),
    breakGlassOnly: z.boolean(),
    passwordMinLength: z.number().int().min(8).max(128),
    lockoutThreshold: z.number().int().min(3).max(50),
    lockoutMinutes: z.number().int().min(1).max(1440),
  }).refine(
    (s) => !(s.requireMfaEveryone || s.requireMfaRoles.length) || s.samlTrustIdpMfa || s.samlRequiredAuthnContexts.length || s.samlRequiredAmr.length,
    { message: 'To require MFA for SAML users, configure at least one required AuthnContext or amr value, or trust the IdP to enforce MFA' },
  ),
  saml: z.object({
    enabled: z.boolean(),
    buttonText: z.string().trim().min(1).max(60),
    metadataSource: z.enum(['url', 'file', 'manual']),
    metadataUrl: z.string().max(2000),
    allowPrivateMetadataHosts: z.boolean(),
    idpEntityId: z.string().max(1000),
    ssoUrl: z.string().max(2000),
    sloUrl: z.string().max(2000),
    idpCerts: z.array(z.string().max(10000)).max(10),
    spEntityId: z.string().max(1000),
    spCert: z.string().max(10000),
    spPrivateKeyEnc: z.string().max(20000),
    signAuthnRequests: z.boolean(),
    wantAssertionsSigned: z.boolean(),
    wantResponseSigned: z.boolean(),
    allowSha1: z.boolean(),
    nameIdFormat: z.string().max(300),
    uniqueIdAttribute: z.string().max(300), // '' => use NameID
    attrEmail: z.string().max(300),
    attrFirstName: z.string().max(300),
    attrLastName: z.string().max(300),
    attrDisplayName: z.string().max(300),
    attrGroups: z.string().max(300),
    defaultRoleId: z.number().int().nullable(),
    clockSkewSec: z.number().int().min(0).max(300),
  }),
  api: z.object({
    enabled: z.boolean(), // off: /v1 refuses every request (the keys are kept)
    maxKeysPerUser: z.number().int().min(1).max(100),
    rateLimitPerMin: z.number().int().min(1).max(100000), // per key
    maxKeyDays: z.number().int().min(0).max(3650), // 0 = keys may be created without an expiry
  }),
  tls: z.object({ mode: z.enum(['unset', 'self-signed', 'none']) }),
  setup: z.object({ completed: z.boolean(), skipped: z.boolean(), completedBy: z.number().int().nullable() }),
  webSearch: z.object({
    provider: z.enum(['', 'brave', 'searxng']),
    url: z.string().max(2000),
    allowPrivate: z.boolean(),
    apiKeyEnc: z.string().max(2000),
  }),
};

export const NAMEID = {
  persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  unspecified: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
  emailAddress: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  transient: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
};

export const defaults = {
  courses: { allowedModelIds: null, subpanels: [
    { id: 'notes', label: 'My notes', type: 'notes', enabled: true },
    { id: 'hints', label: 'Hints', type: 'hints', enabled: true },
    { id: 'resources', label: 'Resources', type: 'resources', enabled: true },
    { id: 'progress', label: 'My progress', type: 'progress', enabled: true },
  ] },
  general: {
    appName: 'OpenWebCodeUI', tagline: '', aiDisclaimer: '', contactName: '', contactEmail: '',
    helpdeskEmail: '', helpdeskPhone: '', helpdeskUrl: '', helpdeskHours: '', supportMessage: '', loginBanner: '', termsNotice: '',
    maxUploadMb: 50, maxAttachmentMb: 10, memoryAllowed: true, coursesEnabled: true, webSearchAllowed: false, userMcpAllowed: true, execMode: 'files_only', shellTimeoutSec: shellDefaults.timeoutSec,
    shellOutputCapBytes: shellDefaults.outputCapBytes, maxAgentIterations: 30, showSessionCost: false, showModelPricing: false, funMode: false,
    secretGlobs: ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', '.npmrc', '.aws/credentials'],
    defaultModels: { plan: null, act: null, chat: null },
  },
  branding: {
    primaryColor: '#3f51b5', secondaryColor: '#009688', colorMode: 'manual', primaryColorDark: '#8c9eff', secondaryColorLight: '#00796b',
    buttonTextLight: '#ffffff', buttonTextDark: '#000000', backgroundColor: '#f5f6fa', surfaceColor: '#ffffff',
    defaultMode: 'system', fontFamily: 'Roboto, "Helvetica Neue", Arial, sans-serif', fontUrl: '', borderRadius: 8,
    density: 'comfortable', monacoTheme: 'system', loginText: '', personaName: '', logoDataUrl: '', faviconDataUrl: '',
  },
  security: {
    requireMfaEveryone: false, requireMfaRoles: ['administrator'],
    samlRequiredAuthnContexts: [
      'http://schemas.microsoft.com/claims/multipleauthn',
      'urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract',
      'urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken',
    ],
    samlRequiredAmr: ['mfa'], samlAmrAttribute: 'amr', samlTrustIdpMfa: false, samlMaxAuthAgeSec: 0, samlForceAuthn: false,
    mfaGraceDays: 0, stepupWindowSec: 600, sessionIdleSec: 3600, sessionAbsoluteSec: 43200,
    localLoginEnabled: true, breakGlassOnly: false, passwordMinLength: 12, lockoutThreshold: 5, lockoutMinutes: 15,
  },
  saml: {
    enabled: false, buttonText: 'Log in with SSO', metadataSource: 'manual', metadataUrl: '', allowPrivateMetadataHosts: false, idpEntityId: '', ssoUrl: '',
    sloUrl: '', idpCerts: [], spEntityId: '', spCert: '', spPrivateKeyEnc: '', signAuthnRequests: false,
    wantAssertionsSigned: true, wantResponseSigned: false, allowSha1: false,
    nameIdFormat: NAMEID.persistent, uniqueIdAttribute: '',
    attrEmail: 'email', attrFirstName: 'firstName', attrLastName: 'lastName', attrDisplayName: 'displayName',
    attrGroups: 'memberOf', defaultRoleId: null, clockSkewSec: 60,
  },
  // The administrator's HTTPS decision; only used when neither the environment nor a reverse proxy decides. Applied at startup.
  tls: { mode: 'unset' },
  // The provider API this server offers to other programs. Off until an administrator turns it on.
  api: { enabled: false, maxKeysPerUser: 10, rateLimitPerMin: 60, maxKeyDays: 0 },
  // First-run setup wizard: shown to an administrator until someone finishes or skips it.
  setup: { completed: false, skipped: false, completedBy: null },
  // The API key is stored encrypted (apiKeyEnc) and never returned to the browser.
  webSearch: { provider: '', url: '', allowPrivate: false, apiKeyEnc: '' },
};

// Public subset exposed unauthenticated for theming the login page.
export const PUBLIC_GENERAL = ['appName', 'aiDisclaimer', 'tagline', 'helpdeskEmail', 'helpdeskPhone', 'helpdeskUrl', 'helpdeskHours', 'supportMessage', 'loginBanner', 'termsNotice', 'contactName', 'contactEmail', 'funMode', 'coursesEnabled'];

export function getSettings(group) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get(group);
  return { ...defaults[group], ...(row ? JSON.parse(row.value) : {}) };
}

export const coursesEnabled = () => !!getSettings('general').coursesEnabled;

export function saveSettings(group, value) {
  const parsed = schemas[group].parse(value);
  getDb().prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(group, JSON.stringify(parsed));
  return parsed;
}

export function publicConfig() {
  const g = getSettings('general');
  const saml = getSettings('saml');
  const sec = getSettings('security');
  return {
    general: Object.fromEntries(PUBLIC_GENERAL.map((k) => [k, g[k]])),
    branding: getSettings('branding'),
    samlEnabled: !!(saml.enabled && saml.ssoUrl),
    ssoButtonText: saml.buttonText || defaults.saml.buttonText,
    localLoginEnabled: sec.localLoginEnabled,
    shellEnabled: g.execMode === 'workspace_shell',
  };
}
