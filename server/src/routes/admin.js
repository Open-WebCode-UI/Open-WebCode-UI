import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { getKnex } from '../db/index.js';
import { insertId, trx } from '../db/dialect.js';
import { defineRoutes, fail, validate, z, stepupOk } from '../http.js';
import { getSettings, saveSettings, publicConfig, NAMEID, schemas } from '../settings.js';
import { audit, verifyAudit } from '../audit.js';
import { ALL_PERMISSIONS, PERMISSIONS } from '../permissions.js';
import { loadIdpMetadata } from '../auth/idp-metadata.js';
import { generateSpCert, spMetadataXml, acsUrl, spEntityId } from '../auth/saml.js';
import { createLocalUser, setUserRoles, userDto, hashPassword, checkPassword, PASSWORD_MAX } from '../users.js';
import { isLastAdmin } from '../auth/rbac.js';
import { resetMfa } from '../auth/mfa.js';
import { revokeUserSessions } from '../auth/session.js';
import { sanitizeSvg } from '../svg.js';
import { terminals } from '../terminal/manager.js';
import { kernels } from '../terminal/kernel.js';
import { encrypt } from '../crypto.js';
import { assertSafeUrl } from '../net-guard.js';
import { runWebSearch, searchBackend } from '../websearch.js';
import { config } from '../config.js';
import { certInfo, ensureSelfSigned, getTlsRuntime, tlsManagement } from '../tls.js';

const actor = (req) => req.user.id;
// Ids come from the URL as text; anything that is not a whole number matches nothing.
const intParam = (v) => { const n = Number(v); return Number.isInteger(n) ? n : -1; };

export function adminRouter({ webSearch = {} } = {}) {
  const r = express.Router();
  const route = defineRoutes(r, '/api');
  const k = () => getKnex();

  route.get('/public-config', 'public', (_req, res) => res.json(publicConfig()));
  route.get('/permissions', 'authenticated', (_req, res) => res.json(PERMISSIONS));

  // ---------- General / Branding / Security settings
  // General settings that widen what code can run on the host or what the agent may read. execMode has its own step-up route;
  // the rest need a recent step-up here too, only when they actually change (the settings form re-sends every field).
  const EXEC_KEYS = ['shellTimeoutSec', 'shellOutputCapBytes', 'secretGlobs'];
  const changedKeys = (before, saved) => Object.keys(saved).filter((k) => JSON.stringify(saved[k]) !== JSON.stringify(before[k]));
  const group = (name, readPerm, writePerm, { sensitive = false } = {}) => {
    route.get(`/admin/${name}`, readPerm, (_req, res) => res.json(getSettings(name)));
    route.put(`/admin/${name}`, sensitive ? { perm: writePerm, stepup: true } : writePerm, async (req, res) => {
      const before = getSettings(name);
      const next = schemas[name].parse({ ...before, ...req.body });
      const changed = changedKeys(before, next);
      if (name === 'general') {
        if (changed.includes('execMode')) fail(400, 'use_exec_mode_endpoint', { message: 'Change the execution mode with PUT /api/admin/general/exec-mode (requires step-up).' });
        if (changed.some((k) => EXEC_KEYS.includes(k)) && !stepupOk(req)) return res.status(403).json({ error: 'mfa_required', stepup: true, method: req.user.source === 'local' ? 'local' : 'saml' });
      }
      if (name === 'security' && next.samlTrustIdpMfa) {
        const saml = getSettings('saml');
        if (!saml.enabled || !saml.ssoUrl || !saml.idpCerts.length) fail(400, 'saml_not_enabled', { message: 'Enable and configure SAML before trusting the IdP to enforce MFA.' });
      }
      const saved = await saveSettings(name, next);
      await audit(actor(req), `settings.${name}.update`, null, { changed });
      if (name === 'general' && saved.execMode !== 'workspace_shell') { terminals.killAll(); kernels.killAll(); } // shell mode off: end every live shell and notebook kernel
      res.json(saved);
    });
  };
  group('general', 'settings.read', 'settings.write');
  group('branding', 'branding.read', 'branding.write');
  group('security', 'security.read', 'security.write', { sensitive: true });

  // ---------- Web search service (the on/off switch for the tenant is general.webSearchAllowed)
  // The API key is write-only: it is stored encrypted and only its presence is reported back.
  const webSearchDto = (w) => ({ provider: w.provider, url: w.url, allowPrivate: w.allowPrivate, apiKeySet: !!w.apiKeyEnc });
  route.get('/admin/web-search', 'settings.read', (_req, res) => res.json(webSearchDto(getSettings('webSearch'))));
  route.put('/admin/web-search', { perm: 'settings.write', stepup: true }, async (req, res) => {
    const b = validate(z.object({
      provider: z.enum(['', 'brave', 'searxng']), url: z.string().trim().max(2000).default(''), allowPrivate: z.boolean().default(false),
      apiKey: z.string().max(500).optional(), // omitted keeps the stored key, '' removes it
    }).strict(), req.body);
    const before = getSettings('webSearch');
    const next = { provider: b.provider, url: b.provider === 'searxng' ? b.url : '', allowPrivate: b.provider === 'searxng' && b.allowPrivate,
      apiKeyEnc: b.provider !== 'brave' ? '' : b.apiKey === undefined ? before.apiKeyEnc : b.apiKey.trim() ? encrypt(b.apiKey.trim()) : '' };
    if (next.provider === 'searxng') {
      if (!next.url) fail(400, 'url_required', { message: 'Enter the address of your SearXNG instance.' });
      await assertSafeUrl(next.url, { allowPrivate: next.allowPrivate });
    }
    const saved = await saveSettings('webSearch', next);
    await audit(actor(req), 'settings.web_search.update', saved.provider || 'none', { provider: saved.provider, keyChanged: next.apiKeyEnc !== before.apiKeyEnc, allowPrivate: saved.allowPrivate });
    res.json(webSearchDto(saved));
  });

  // Runs one real search with the saved settings so an administrator can confirm they work.
  route.post('/admin/web-search/test', 'settings.write', async (req, res) => {
    if (!searchBackend()) fail(400, 'not_configured', { message: 'Save a search service first.' });
    const out = await runWebSearch('web search test', { userId: `admin-test:${req.user.id}`, fetchImpl: webSearch.fetchImpl });
    res.json(out.startsWith('Error:') ? { ok: false, message: out.slice(7) } : { ok: true, message: out.split('\n')[0].startsWith('No web results') ? 'The service answered, but returned no results.' : 'The service answered with results.' });
  });

  // ---------- HTTPS / certificate
  // The environment (TLS_CERT/TLS_KEY, https://localhost) or a reverse proxy (TRUST_PROXY) can decide on its own. Only when nothing
  // does is the administrator asked to choose between a self-signed certificate and no HTTPS. The server binds its listener at
  // startup, so a change is saved now and takes effect after the server restarts.
  const tlsHost = () => new URL(config.baseUrl).hostname;
  const savedCert = () => { try { return fs.readFileSync(path.join(config.dataDir, 'tls', 'server.crt')); } catch { return null; } };
  const tlsDto = () => {
    const managedBy = tlsManagement({ baseUrl: config.baseUrl }), mode = getSettings('tls').mode, running = getTlsRuntime();
    const wantHttps = mode === 'self-signed';
    const pending = managedBy === 'admin' && wantHttps ? savedCert() : null;
    const restartRequired = managedBy === 'admin' && mode !== 'unset' && (wantHttps !== running.https
      || (wantHttps && !!pending && !!running.cert && certInfo(pending).fingerprint !== certInfo(running.cert).fingerprint));
    return {
      managedBy, mode: managedBy === 'admin' ? mode : null, needsChoice: managedBy === 'admin' && mode === 'unset',
      running: { https: running.https, source: running.source }, hostname: tlsHost(), restartRequired,
      certificate: running.cert ? certInfo(running.cert) : null, pendingCertificate: restartRequired && pending ? certInfo(pending) : null,
    };
  };
  const adminTlsOnly = () => { if (tlsManagement({ baseUrl: config.baseUrl }) !== 'admin') fail(409, 'tls_managed_elsewhere', { message: 'HTTPS is set by the server environment (TLS_CERT/TLS_KEY, a localhost BASE_URL, or TRUST_PROXY) and cannot be changed here.' }); };
  route.get('/admin/tls', 'settings.read', (_req, res) => res.json(tlsDto()));
  route.put('/admin/tls', { perm: 'settings.write', stepup: true }, async (req, res) => {
    const b = validate(z.object({ mode: z.enum(['self-signed', 'none']) }).strict(), req.body);
    adminTlsOnly();
    if (b.mode === 'self-signed') await ensureSelfSigned({ dataDir: config.dataDir, hostnames: [tlsHost()], name: 'server' });
    const before = getSettings('tls').mode;
    await saveSettings('tls', { mode: b.mode });
    await audit(actor(req), 'settings.tls.update', b.mode, { from: before });
    res.json(tlsDto());
  });
  route.post('/admin/tls/regenerate', { perm: 'settings.write', stepup: true }, async (req, res) => {
    adminTlsOnly();
    if (getSettings('tls').mode !== 'self-signed') fail(400, 'not_self_signed', { message: 'Choose a self-signed certificate first.' });
    await ensureSelfSigned({ dataDir: config.dataDir, hostnames: [tlsHost()], name: 'server', force: true });
    await audit(actor(req), 'tls.regenerate', 'self-signed');
    res.json(tlsDto());
  });

  // exec-mode changes enable a shell on the host: require step-up + audit explicitly.
  route.put('/admin/general/exec-mode', { perm: 'settings.write', stepup: true }, async (req, res) => {
    const { execMode } = validate(z.object({ execMode: z.enum(['files_only', 'workspace_shell']) }), req.body);
    const before = getSettings('general');
    await saveSettings('general', { ...before, execMode });
    await audit(actor(req), 'settings.exec_mode', execMode, { from: before.execMode });
    if (execMode !== 'workspace_shell') { terminals.killAll(); kernels.killAll(); }
    res.json({ execMode });
  });

  route.post('/admin/branding/upload', 'branding.write', express.json({ limit: '1mb' }), async (req, res) => {
    const { kind, dataUrl } = validate(z.object({ kind: z.enum(['logo', 'favicon']), dataUrl: z.string().max(900_000) }), req.body);
    const m = /^data:(image\/(?:png|jpeg|svg\+xml|x-icon|vnd\.microsoft\.icon|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) fail(400, 'unsupported_image_type');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > (kind === 'logo' ? 500_000 : 100_000)) fail(413, 'image_too_large');
    let out = dataUrl;
    if (m[1] === 'image/svg+xml') {
      const clean = sanitizeSvg(buf.toString('utf8'));
      if (!clean) fail(400, 'invalid_svg');
      out = `data:image/svg+xml;base64,${Buffer.from(clean).toString('base64')}`;
    }
    const b = getSettings('branding');
    await saveSettings('branding', { ...b, [kind === 'logo' ? 'logoDataUrl' : 'faviconDataUrl']: out });
    await audit(actor(req), 'settings.branding.upload', kind);
    res.json({ ok: true });
  });

  // ---------- SAML
  const maskSaml = (s) => ({ ...s, spPrivateKeyEnc: s.spPrivateKeyEnc ? '[set]' : '' });
  route.get('/admin/saml', 'idp.read', async (_req, res) => {
    const s = getSettings('saml');
    res.json({
      settings: maskSaml(s), nameIdFormats: NAMEID,
      roles: await k()('roles').orderBy('id').select('id', 'name'),
      groupMap: await k()('group_role_map').orderBy('group_value').select({ groupValue: 'group_value', roleId: 'role_id' }), acsUrl: acsUrl(), spEntityIdEffective: spEntityId(s),
      spMetadataUrl: `${new URL(acsUrl()).origin}/auth/saml/metadata`,
      nameIdWarning: s.nameIdFormat === NAMEID.persistent ? null
        : s.nameIdFormat === NAMEID.transient ? 'Transient NameIDs cannot identify returning users; choose a unique ID attribute.'
        : 'Persistent is recommended: it is an opaque, privacy-preserving identifier. Non-persistent formats may carry human-readable values.',
    });
  });
  route.put('/admin/saml', { perm: 'idp.write', stepup: true }, async (req, res) => {
    const before = getSettings('saml');
    const body = { ...req.body };
    delete body.spPrivateKeyEnc; // never overwritten from the UI; use /sp-cert
    const merged = { ...before, ...body };
    if (merged.nameIdFormat === NAMEID.transient && !merged.uniqueIdAttribute) fail(400, 'transient_requires_unique_attribute');
    if (merged.defaultRoleId != null && !(await k()('roles').where({ id: merged.defaultRoleId }).first('id'))) fail(400, 'unknown_default_role');
    const saved = await saveSettings('saml', merged);
    await audit(actor(req), 'settings.saml.update', null, { nameIdFormat: saved.nameIdFormat });
    res.json(maskSaml(saved));
  });
  // Auto-populate: fetch/parse only, returns a preview for admin review (not saved).
  route.post('/admin/saml/metadata/preview', 'idp.write', express.json({ limit: '2mb' }), async (req, res) => {
    const b = validate(z.object({ url: z.string().max(2000).optional(), xml: z.string().max(1_500_000).optional() }), req.body);
    const cfg = getSettings('saml');
    const md = await loadIdpMetadata({ url: b.url, xml: b.xml, allowPrivate: cfg.allowPrivateMetadataHosts });
    await audit(actor(req), 'settings.saml.metadata_preview', b.url || 'upload');
    res.json(md);
  });
  route.post('/admin/saml/sp-cert', { perm: 'idp.write', stepup: true }, async (req, res) => {
    const { cert, privateKeyEnc } = await generateSpCert();
    await saveSettings('saml', { ...getSettings('saml'), spCert: cert, spPrivateKeyEnc: privateKeyEnc });
    await audit(actor(req), 'settings.saml.sp_cert_generated');
    res.json({ spCert: cert });
  });
  route.get('/admin/saml/sp-metadata', 'idp.read', (_req, res) => res.type('application/xml').send(spMetadataXml()));

  // ---------- Roles & group mapping
  const roleDto = async (row) => ({
    id: row.id, name: row.name, description: row.description, builtin: !!row.builtin,
    permissions: (await k()('role_permissions').where({ role_id: row.id }).select('permission')).map((p) => p.permission),
  });
  route.get('/admin/roles', 'role.read', async (_req, res) => {
    res.json({
      roles: await Promise.all((await k()('roles').orderBy('id')).map(roleDto)),
      groupMap: await k()('group_role_map as g').orderBy('g.group_value').select({ groupValue: 'g.group_value', roleId: 'g.role_id' }),
    });
  });
  const roleBody = z.object({
    name: z.string().min(1).max(60).regex(/^[\w .-]+$/), description: z.string().max(300).default(''),
    permissions: z.array(z.enum(ALL_PERMISSIONS)),
  });
  const grantPermissions = (t, roleId, permissions) => (permissions.length
    ? t('role_permissions').insert([...new Set(permissions)].map((permission) => ({ role_id: roleId, permission })))
    : null);
  route.post('/admin/roles', { perm: 'role.write', stepup: true }, async (req, res) => {
    const b = validate(roleBody, req.body);
    if (await k()('roles').where({ name: b.name }).first('id')) fail(409, 'role_exists');
    const id = await trx(k(), async (t) => {
      const roleId = await insertId(t('roles'), { name: b.name, description: b.description });
      await grantPermissions(t, roleId, b.permissions);
      return roleId;
    });
    await audit(actor(req), 'role.create', b.name, { permissions: b.permissions });
    res.status(201).json(await roleDto(await k()('roles').where({ id }).first()));
  });
  route.put('/admin/roles/:id', { perm: 'role.write', stepup: true }, async (req, res) => {
    const role = await k()('roles').where({ id: intParam(req.params.id) }).first();
    if (!role) fail(404, 'not_found');
    if (role.builtin && role.name === 'administrator') fail(400, 'administrator_immutable');
    const b = validate(roleBody, req.body);
    await trx(k(), async (t) => {
      await t('roles').where({ id: role.id }).update({ name: role.builtin ? role.name : b.name, description: b.description });
      await t('role_permissions').where({ role_id: role.id }).del();
      await grantPermissions(t, role.id, b.permissions);
    });
    await audit(actor(req), 'role.update', role.name, { permissions: b.permissions });
    res.json(await roleDto(await k()('roles').where({ id: role.id }).first()));
  });
  route.delete('/admin/roles/:id', { perm: 'role.write', stepup: true }, async (req, res) => {
    const role = await k()('roles').where({ id: intParam(req.params.id) }).first();
    if (!role) fail(404, 'not_found');
    if (role.builtin) fail(400, 'builtin_role');
    await k()('roles').where({ id: role.id }).del();
    await audit(actor(req), 'role.delete', role.name);
    res.json({ ok: true });
  });
  route.put('/admin/group-map', { perm: 'role.write', stepup: true }, async (req, res) => {
    const b = validate(z.object({ mappings: z.array(z.object({ groupValue: z.string().min(1).max(500), roleId: z.number().int() })).max(1000) }), req.body);
    await trx(k(), async (t) => {
      await t('group_role_map').del();
      for (const m of b.mappings) {
        if (!(await t('roles').where({ id: m.roleId }).first('id'))) fail(400, 'unknown_role');
        await t('group_role_map').insert({ group_value: m.groupValue, role_id: m.roleId }).onConflict(['group_value', 'role_id']).ignore();
      }
    });
    await audit(actor(req), 'role.group_map.update', null, { count: b.mappings.length });
    res.json({ ok: true });
  });

  // ---------- Users (local authentication CRUD)
  route.get('/admin/users', 'user.read', async (_req, res) => {
    res.json(await Promise.all((await k()('users').orderBy('id')).map(async (u) => await userDto(u))));
  });
  const userCreate = z.object({
    username: z.string().min(3).max(64).regex(/^[\w.@-]+$/), password: z.string().max(PASSWORD_MAX),
    email: z.string().max(200).default(''), firstName: z.string().max(100).default(''), lastName: z.string().max(100).default(''),
    roles: z.array(z.string()).default([]), isBreakGlass: z.boolean().default(false), mustChange: z.boolean().default(true),
  });
  route.post('/admin/users', { perm: 'user.write', stepup: true }, async (req, res) => {
    const b = validate(userCreate, req.body);
    const id = await createLocalUser(b);
    await audit(actor(req), 'user.create', b.username, { roles: b.roles, breakGlass: b.isBreakGlass });
    res.status(201).json(await userDto(await k()('users').where({ id }).first()));
  });
  route.put('/admin/users/:id', { perm: 'user.write', stepup: true }, async (req, res) => {
    const u = await k()('users').where({ id: intParam(req.params.id) }).first();
    if (!u) fail(404, 'not_found');
    const b = validate(z.object({
      email: z.string().max(200).optional(), firstName: z.string().max(100).optional(), lastName: z.string().max(100).optional(),
      disabled: z.boolean().optional(), roles: z.array(z.string()).optional(), isBreakGlass: z.boolean().optional(),
      mustChange: z.boolean().optional(), password: z.string().max(PASSWORD_MAX).optional(),
    }), req.body);
    if (await isLastAdmin(u.id) && (b.disabled === true || (b.roles && !b.roles.includes('administrator')))) fail(400, 'last_administrator');
    if (b.password !== undefined) {
      if (u.source !== 'local') fail(400, 'saml_user_no_password');
      checkPassword(b.password, u.username);
      await k()('users').where({ id: u.id }).update({ password_hash: hashPassword(b.password), must_change_password: 1 });
    }
    if (b.isBreakGlass !== undefined && u.source !== 'local') fail(400, 'saml_user_no_breakglass');
    // Only the fields the request names change; the rest keep their stored values.
    const patch = {};
    if (b.email != null) patch.email = b.email;
    if (b.firstName != null) patch.first_name = b.firstName;
    if (b.lastName != null) patch.last_name = b.lastName;
    if (b.disabled != null) patch.disabled = +b.disabled;
    if (b.isBreakGlass != null) patch.is_break_glass = +b.isBreakGlass;
    if (b.mustChange != null) patch.must_change_password = +b.mustChange;
    if (Object.keys(patch).length) await k()('users').where({ id: u.id }).update(patch);
    if (b.roles) await setUserRoles(u.id, b.roles, 'manual');
    if (b.disabled || b.password) { await revokeUserSessions(u.id); terminals.killForUser(u.id); kernels.killForUser(u.id); }
    await audit(actor(req), 'user.update', u.username || u.email, { fields: Object.keys(b).filter((x) => x !== 'password') });
    res.json(await userDto(await k()('users').where({ id: u.id }).first()));
  });
  route.delete('/admin/users/:id', { perm: 'user.write', stepup: true }, async (req, res) => {
    const u = await k()('users').where({ id: intParam(req.params.id) }).first();
    if (!u) fail(404, 'not_found');
    if (u.id === req.user.id) fail(400, 'cannot_delete_self');
    if (await isLastAdmin(u.id)) fail(400, 'last_administrator');
    await k()('users').where({ id: u.id }).del();
    terminals.killForUser(u.id); kernels.killForUser(u.id);
    await audit(actor(req), 'user.delete', u.username || u.email);
    res.json({ ok: true });
  });
  route.post('/admin/users/:id/reset-mfa', { perm: 'mfa.reset', stepup: true }, async (req, res) => {
    const u = await k()('users').where({ id: intParam(req.params.id) }).first();
    if (!u) fail(404, 'not_found');
    await resetMfa(u.id);
    await audit(actor(req), 'mfa.reset', u.username || u.email);
    res.json({ ok: true });
  });

  // ---------- Audit
  // Keyset-paginated, newest first: `before` is the id of the last row already loaded.
  // The integrity check walks the whole chain, so it is only run for the first page.
  route.get('/admin/audit', 'audit.read', async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const before = Number(req.query.before) || null;
    const rows = await k()('audit').select('id', 'ts', 'actor', 'action', 'target', 'detail').modify((q) => { if (before) q.where('id', '<', before); })
      .orderBy('id', 'desc').limit(limit + 1);
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    res.json({ rows, hasMore, nextBefore: hasMore ? rows[rows.length - 1].id : null, ...(before ? {} : { integrity: await verifyAudit() }) });
  });

  return r;
}
