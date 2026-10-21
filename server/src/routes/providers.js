import express from 'express';
import { getDb } from '../db/index.js';
import { defineRoutes, fail, validate, z } from '../http.js';
import { encrypt, maskSecret } from '../crypto.js';
import { audit } from '../audit.js';
import { createAdapter, PROVIDER_TYPES } from '../llm/provider.js';
import { assertSafeUrl } from '../net-guard.js';
import { getSettings, saveSettings } from '../settings.js';
import { userRoleNames } from '../auth/rbac.js';
import { THINKING_MODES, defaultThinking } from '../llm/thinking.js';
import { badgesFor } from './badges.js';

const dto = (p) => {
  const db = getDb();
  return {
    id: p.id, name: p.name, type: p.type, enabled: !!p.enabled, config: JSON.parse(p.config), hasSecret: !!p.secret_enc, secret: maskSecret(p.secret_enc),
    allowedRoles: JSON.parse(p.allowed_roles), helpText: p.help_text || '', fileUploads: !!p.file_uploads, imageUploads: !!p.image_uploads,
    models: db.prepare('SELECT id, model_id modelId, label, enabled, max_tokens maxTokens, temperature, context_size contextSize, auto_context autoContext, thinking_mode thinkingMode, thinking_budget thinkingBudget, subagents, file_uploads fileUploads, image_uploads imageUploads, input_price inputPrice, output_price outputPrice, help_text helpText, featured_badge_id featuredBadgeId FROM models WHERE provider_id=? ORDER BY position, id').all(p.id)
      .map((m) => ({ ...m, enabled: !!m.enabled, subagents: !!m.subagents, fileUploads: m.fileUploads == null ? null : !!m.fileUploads, imageUploads: m.imageUploads == null ? null : !!m.imageUploads, autoContext: !!m.autoContext, badgeIds: badgesFor(m.id).map((b) => b.id) })),
  };
};
const cfgSchema = z.object({
  baseUrl: z.string().max(500).optional(), region: z.string().max(50).optional(),
  deployment: z.string().max(200).optional(), project: z.string().max(100).optional(), location: z.string().max(50).optional(), apiVersion: z.string().max(50).optional(),
}).strict();
const body = z.object({
  name: z.string().min(1).max(80), type: z.enum(PROVIDER_TYPES), config: cfgSchema.default({}),
  secret: z.string().max(5000).optional(), enabled: z.boolean().default(true), allowedRoles: z.array(z.string()).default([]),
  helpText: z.string().trim().max(1000).optional(), // shown to users in the model picker; plain text
  fileUploads: z.boolean().optional(), imageUploads: z.boolean().optional(), // default for this connection's models; a model can override either
});

// Admin-supplied provider URLs are validated: http(s) only; private/loopback hosts allowed only for LM Studio, Ollama, and generic servers (self-hosted by design).
async function checkProviderUrl(type, cfg, lookup) {
  if (type === 'vertex' && !cfg.project) fail(400, 'vertex_requires_project');
  if (!cfg.baseUrl) { if (type === 'azure') fail(400, 'azure_requires_endpoint'); if (type === 'generic') fail(400, 'generic_requires_base_url'); return; }
  await assertSafeUrl(cfg.baseUrl, { allowPrivate: ['lmstudio', 'ollama', 'generic'].includes(type), lookup }).catch((e) => fail(400, e.message === 'private_address_blocked' ? 'private_address_blocked_for_type' : e.message));
}

// Asks the provider whether a model can think. true/false when it says so; null when it can't tell (unsupported by the adapter, offline, slow).
// Cached so the model picker doesn't hit the provider on every load.
const probeCache = new Map(), PROBE_TTL_MS = 10 * 60_000, PROBE_TIMEOUT_MS = 3000;
async function probeThinking(adapterFactory, provider, modelId) {
  const k = `${provider.id}:${provider.type}:${provider.config}:${modelId}`, hit = probeCache.get(k);
  if (hit && hit.exp > Date.now()) return hit.v;
  let v = null;
  try {
    const a = adapterFactory(provider);
    if (a.supportsThinking) v = await Promise.race([a.supportsThinking(modelId), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), PROBE_TIMEOUT_MS))]);
    if (typeof v !== 'boolean') v = null;
  } catch { v = null; }
  probeCache.set(k, { v, exp: Date.now() + (v === null ? 60_000 : PROBE_TTL_MS) });
  return v;
}

export function providersRouter({ adapterFactory = createAdapter, lookup } = {}) {
  const r = express.Router();
  const route = defineRoutes(r, '/api');
  const get = (id) => getDb().prepare('SELECT * FROM providers WHERE id=?').get(id) || fail(404, 'not_found');

  route.get('/admin/providers', 'provider.read', (_req, res) => res.json(getDb().prepare('SELECT * FROM providers ORDER BY position, id').all().map(dto)));
  route.post('/admin/providers', { perm: 'provider.write', stepup: true }, async (req, res) => {
    const b = validate(body, req.body);
    await checkProviderUrl(b.type, b.config, lookup);
    const id = Number(getDb().prepare('INSERT INTO providers (name,type,config,secret_enc,enabled,allowed_roles,help_text,file_uploads,image_uploads) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(b.name, b.type, JSON.stringify(b.config), b.secret ? encrypt(b.secret) : null, +b.enabled, JSON.stringify(b.allowedRoles), b.helpText ?? '', +(b.fileUploads ?? false), +(b.imageUploads ?? false)).lastInsertRowid);
    getDb().prepare('UPDATE providers SET position=(SELECT COALESCE(MAX(position),0)+1 FROM providers) WHERE id=?').run(id); // new connections go last
    audit(req.user.id, 'provider.create', b.name, { type: b.type });
    res.status(201).json(dto(get(id)));
  });
  // Reorder: the body lists every id in the new order. Registered before '/:id' so "order" is never read as an id.
  const reorder = (table, where, args, ids) => {
    const cur = getDb().prepare(`SELECT id FROM ${table} WHERE ${where}`).all(...args).map((x) => x.id);
    if (ids.length !== cur.length || new Set(ids).size !== ids.length || !ids.every((i) => cur.includes(i))) fail(400, 'order_mismatch', { message: 'The list must contain every item exactly once.' });
    const set = getDb().prepare(`UPDATE ${table} SET position=? WHERE id=?`);
    getDb().transaction(() => ids.forEach((id, i) => set.run(i + 1, id)))();
  };
  const orderBody = z.object({ ids: z.array(z.number().int()).max(1000) });
  route.put('/admin/providers/order', 'provider.write', (req, res) => {
    const { ids } = validate(orderBody, req.body);
    reorder('providers', '1=1', [], ids);
    audit(req.user.id, 'provider.reorder', null, { ids });
    res.json({ ok: true });
  });
  route.put('/admin/providers/:id/models/order', 'provider.write', (req, res) => {
    const p = get(req.params.id), { ids } = validate(orderBody, req.body);
    reorder('models', 'provider_id=?', [p.id], ids);
    audit(req.user.id, 'provider.models.reorder', p.name, { ids });
    res.json({ ok: true });
  });
  route.put('/admin/providers/:id', { perm: 'provider.write', stepup: true }, async (req, res) => {
    const p = get(req.params.id), b = validate(body, req.body);
    await checkProviderUrl(b.type, b.config, lookup);
    getDb().prepare('UPDATE providers SET name=?, type=?, config=?, secret_enc=COALESCE(?,secret_enc), enabled=?, allowed_roles=?, help_text=COALESCE(?,help_text), file_uploads=COALESCE(?,file_uploads), image_uploads=COALESCE(?,image_uploads) WHERE id=?')
      .run(b.name, b.type, JSON.stringify(b.config), b.secret ? encrypt(b.secret) : null, +b.enabled, JSON.stringify(b.allowedRoles), b.helpText ?? null, b.fileUploads === undefined ? null : +b.fileUploads, b.imageUploads === undefined ? null : +b.imageUploads, p.id);
    audit(req.user.id, 'provider.update', b.name, { secretChanged: !!b.secret, helpTextChanged: b.helpText !== undefined && b.helpText !== (p.help_text || '') });
    res.json(dto(get(p.id)));
  });
  route.delete('/admin/providers/:id', { perm: 'provider.write', stepup: true }, (req, res) => {
    const p = get(req.params.id);
    getDb().prepare('DELETE FROM providers WHERE id=?').run(p.id);
    audit(req.user.id, 'provider.delete', p.name);
    res.json({ ok: true });
  });
  // Query a connection for its available models BEFORE it is saved (or while editing). Nothing is persisted.
  // The stored secret is only reused when the endpoint is unchanged, so it can't be sent to a different host.
  route.post('/admin/providers/discover', 'provider.write', async (req, res) => {
    const b = validate(z.object({ type: z.enum(PROVIDER_TYPES), config: cfgSchema.default({}), secret: z.string().max(5000).optional(), providerId: z.number().int().optional() }), req.body);
    await checkProviderUrl(b.type, b.config, lookup);
    let secretEnc = b.secret ? encrypt(b.secret) : null;
    if (!secretEnc && b.providerId) {
      const stored = get(b.providerId), sc = JSON.parse(stored.config);
      const same = stored.type === b.type && ['baseUrl', 'region', 'deployment', 'apiVersion', 'project', 'location'].every((k) => (sc[k] || '') === (b.config[k] || ''));
      if (!same) fail(400, 'secret_required', { message: 'Re-enter the API key to query a changed endpoint.' });
      secretEnc = stored.secret_enc;
    }
    try {
      const adapter = adapterFactory({ type: b.type, config: JSON.stringify(b.config), secret_enc: secretEnc });
      const models = await Promise.race([adapter.listModels(), new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out after 20 seconds')), 20_000))]);
      audit(req.user.id, 'provider.discover', b.type, { count: models.length });
      res.json({ ok: true, models });
    } catch (e) {
      let msg = String(e.message || 'Request failed').slice(0, 300);
      if (b.secret) msg = msg.split(b.secret).join('***');
      res.json({ ok: false, error: msg });
    }
  });
  route.post('/admin/providers/:id/test', 'provider.write', async (req, res) => {
    const p = get(req.params.id);
    try {
      const a = adapterFactory(p);
      const models = await a.listModels();
      res.json({ ok: true, models });
    } catch (e) { res.json({ ok: false, error: String(e.message).slice(0, 300) }); }
  });
  route.post('/admin/providers/:id/models', 'provider.write', (req, res) => {
    const p = get(req.params.id);
    const b = validate(z.object({
      modelId: z.string().min(1).max(300), label: z.string().max(100).optional(), maxTokens: z.number().int().min(1).max(5_000_000).default(4096),
      temperature: z.number().min(0).max(2).nullable().default(null), contextSize: z.number().int().min(1000).max(10_000_000).nullable().default(null), enabled: z.boolean().default(true),
      subagents: z.boolean().optional(), fileUploads: z.boolean().nullable().optional(), imageUploads: z.boolean().nullable().optional(), autoContext: z.boolean().optional(), thinkingMode: z.enum(THINKING_MODES).optional(), thinkingBudget: z.number().int().min(1024).max(128000).nullable().optional(),
      inputPrice: z.number().min(0).max(100000).nullable().optional(), outputPrice: z.number().min(0).max(100000).nullable().optional(), // USD per 1M tokens
      helpText: z.string().trim().max(500).optional(), // shown to users on this model's card; plain text
    }), req.body);
    const dflt = defaultThinking(p.type, b.modelId); // suggested for new rows; an explicit choice (or an existing row's setting) wins
    const mode = b.thinkingMode ?? dflt.mode;
    const budget = mode === 'budget' ? (b.thinkingBudget ?? dflt.budget ?? 8000) : null;
    getDb().prepare(`INSERT INTO models (provider_id, model_id, label, enabled, max_tokens, temperature, context_size, auto_context, thinking_mode, thinking_budget, subagents, file_uploads, image_uploads, input_price, output_price, help_text) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(provider_id, model_id) DO UPDATE SET label=excluded.label, enabled=excluded.enabled, max_tokens=excluded.max_tokens, temperature=excluded.temperature, context_size=excluded.context_size,
        thinking_mode=CASE WHEN ? THEN excluded.thinking_mode ELSE thinking_mode END, thinking_budget=CASE WHEN ? THEN excluded.thinking_budget ELSE thinking_budget END,
        auto_context=CASE WHEN ? THEN excluded.auto_context ELSE auto_context END,
        subagents=CASE WHEN ? THEN excluded.subagents ELSE subagents END,
        file_uploads=CASE WHEN ? THEN excluded.file_uploads ELSE file_uploads END, image_uploads=CASE WHEN ? THEN excluded.image_uploads ELSE image_uploads END,
        input_price=CASE WHEN ? THEN excluded.input_price ELSE input_price END, output_price=CASE WHEN ? THEN excluded.output_price ELSE output_price END,
        help_text=CASE WHEN ? THEN excluded.help_text ELSE help_text END`)
      .run(p.id, b.modelId, b.label || b.modelId, +b.enabled, b.maxTokens, b.temperature, b.contextSize, +(b.autoContext ?? false), mode, budget, +(b.subagents ?? true), b.fileUploads == null ? null : +b.fileUploads, b.imageUploads == null ? null : +b.imageUploads, b.inputPrice ?? null, b.outputPrice ?? null, b.helpText ?? '', +(b.thinkingMode !== undefined), +(b.thinkingMode !== undefined), +(b.autoContext !== undefined), +(b.subagents !== undefined), +(b.fileUploads !== undefined), +(b.imageUploads !== undefined), +(b.inputPrice !== undefined), +(b.outputPrice !== undefined), +(b.helpText !== undefined));
    getDb().prepare('UPDATE models SET position=(SELECT COALESCE(MAX(position),0)+1 FROM models WHERE provider_id=?) WHERE provider_id=? AND model_id=? AND position=0').run(p.id, p.id, b.modelId); // new models go last
    audit(req.user.id, 'provider.model.upsert', p.name, { model: b.modelId, enabled: b.enabled, ...(b.inputPrice !== undefined || b.outputPrice !== undefined ? { inputPrice: b.inputPrice, outputPrice: b.outputPrice } : {}) });
    res.json(dto(get(p.id)));
  });
  route.delete('/admin/models/:id', 'provider.write', (req, res) => {
    getDb().prepare('DELETE FROM models WHERE id=?').run(req.params.id);
    audit(req.user.id, 'provider.model.delete', req.params.id);
    res.json({ ok: true });
  });
  route.put('/admin/default-models', 'provider.write', (req, res) => {
    const dm = validate(z.object({ plan: z.number().int().nullable(), act: z.number().int().nullable(), chat: z.number().int().nullable() }), req.body);
    saveSettings('general', { ...getSettings('general'), defaultModels: dm });
    audit(req.user.id, 'settings.default_models', null, dm);
    res.json(dm);
  });

  // Models the current user may use (enabled provider + enabled model + role allow-list).
  route.get('/models', 'provider.use', async (req, res) => {
    const roles = userRoleNames(req.user.id);
    const rows = getDb().prepare(`SELECT m.id, m.model_id modelId, COALESCE(m.label,m.model_id) label, p.name provider, p.allowed_roles ar, m.thinking_mode tm, m.file_uploads mf, m.image_uploads mi, p.file_uploads pf, p.image_uploads pi, m.context_size contextSize, m.auto_context autoContext, m.max_tokens maxTokens, m.input_price inputPrice, m.output_price outputPrice, m.featured_badge_id featuredBadgeId, p.help_text help, m.help_text modelHelp, p.id pid, p.type ptype, p.config pconfig, p.secret_enc psecret
      FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.enabled=1 AND p.enabled=1 ORDER BY p.position, p.id, m.position, m.id`).all()
      .filter((m) => { const ar = JSON.parse(m.ar); return !ar.length || ar.some((x) => roles.includes(x)); });
    // thinkingCapable: what the provider reports (null = unknown). Only models that could think (admin-enabled) are probed.
    const capable = await Promise.all(rows.map((m) => m.tm === 'off' ? null : probeThinking(adapterFactory, { id: m.pid, type: m.ptype, config: m.pconfig, secret_enc: m.psecret }, m.modelId)));
    const showPricing = getSettings('general').showModelPricing; // prices are admin-entered; users only see them when this is on
    res.json({
      models: rows.map(({ ar, tm, mf, mi, pf, pi, pid, ptype, pconfig, psecret, inputPrice, outputPrice, ...m }, i) => ({ ...m, autoContext: !!m.autoContext, contextSize: m.autoContext ? null : m.contextSize, ...(showPricing ? { inputPrice, outputPrice } : {}), supportsThinking: tm !== 'off' && capable[i] !== false, thinkingCapable: capable[i], supportsFiles: !!(mf ?? pf), supportsImages: !!(mi ?? pi), badges: badgesFor(m.id) })),
      defaults: getSettings('general').defaultModels,
    });
  });
  return r;
}

// What a model accepts: its own switch when set, otherwise its connection's.
export const uploadCaps = ({ model, provider }) => ({ files: !!(model.file_uploads ?? provider.file_uploads), images: !!(model.image_uploads ?? provider.image_uploads) });

export function resolveModel(user, modelRowId) {
  const roles = userRoleNames(user.id);
  const row = getDb().prepare(`SELECT m.*, p.id pid FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=? AND m.enabled=1 AND p.enabled=1`).get(modelRowId);
  if (!row) return null;
  const p = getDb().prepare('SELECT * FROM providers WHERE id=?').get(row.pid);
  const ar = JSON.parse(p.allowed_roles);
  if (ar.length && !ar.some((x) => roles.includes(x))) return null;
  return { model: row, provider: p };
}
