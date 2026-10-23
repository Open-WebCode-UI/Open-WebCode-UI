import express from 'express';
import { getKnex } from '../db/index.js';
import { trx, insertId } from '../db/dialect.js';
import { defineRoutes, fail, validate, z } from '../http.js';
import { encrypt, maskSecret } from '../crypto.js';
import { audit } from '../audit.js';
import { createAdapter, PROVIDER_TYPES } from '../llm/provider.js';
import { assertSafeUrl } from '../net-guard.js';
import { getSettings, saveSettings } from '../settings.js';
import { userRoleNames } from '../auth/rbac.js';
import { THINKING_MODES, defaultThinking } from '../llm/thinking.js';
import { badgesFor } from './badges.js';

// The next display position in a table: one past the highest.
const nextPosition = async (q) => ((await q.max({ m: 'position' }).first()).m ?? 0) + 1;

const MODEL_COLS = ['id', 'model_id as modelId', 'label', 'enabled', 'max_tokens as maxTokens', 'temperature', 'context_size as contextSize', 'auto_context as autoContext',
  'thinking_mode as thinkingMode', 'thinking_budget as thinkingBudget', 'subagents', 'file_uploads as fileUploads', 'image_uploads as imageUploads', 'input_price as inputPrice',
  'output_price as outputPrice', 'help_text as helpText', 'featured_badge_id as featuredBadgeId'];
const dto = async (p) => ({
  id: p.id, name: p.name, type: p.type, enabled: !!p.enabled, config: JSON.parse(p.config), hasSecret: !!p.secret_enc, secret: maskSecret(p.secret_enc),
  allowedRoles: JSON.parse(p.allowed_roles), helpText: p.help_text || '', fileUploads: !!p.file_uploads, imageUploads: !!p.image_uploads,
  models: await Promise.all((await getKnex()('models').where({ provider_id: p.id }).select(MODEL_COLS).orderBy([{ column: 'position' }, { column: 'id' }]))
    .map(async (m) => ({ ...m, enabled: !!m.enabled, subagents: !!m.subagents, fileUploads: m.fileUploads == null ? null : !!m.fileUploads, imageUploads: m.imageUploads == null ? null : !!m.imageUploads, autoContext: !!m.autoContext, badgeIds: (await badgesFor(m.id)).map((b) => b.id) }))),
});
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
  const intId = (v) => { const n = Number(v); return Number.isInteger(n) ? n : fail(404, 'not_found'); };
  const get = async (id) => (await getKnex()('providers').where({ id: intId(id) }).first()) || fail(404, 'not_found');

  route.get('/admin/providers', 'provider.read', async (_req, res) => res.json(await Promise.all((await getKnex()('providers').orderBy([{ column: 'position' }, { column: 'id' }])).map(dto))));
  route.post('/admin/providers', { perm: 'provider.write', stepup: true }, async (req, res) => {
    const b = validate(body, req.body);
    await checkProviderUrl(b.type, b.config, lookup);
    const id = await trx(getKnex(), async (t) => insertId(t('providers'), {
      name: b.name, type: b.type, config: JSON.stringify(b.config), secret_enc: b.secret ? encrypt(b.secret) : null, enabled: +b.enabled, allowed_roles: JSON.stringify(b.allowedRoles),
      help_text: b.helpText ?? '', file_uploads: +(b.fileUploads ?? false), image_uploads: +(b.imageUploads ?? false), position: await nextPosition(t('providers')), // new connections go last
    }));
    audit(req.user.id, 'provider.create', b.name, { type: b.type });
    res.status(201).json(await dto(await get(id)));
  });
  // Reorder: the body lists every id in the new order. Registered before '/:id' so "order" is never read as an id.
  const reorder = async (table, where, ids) => {
    const cur = (await getKnex()(table).where(where).select('id')).map((x) => x.id);
    if (ids.length !== cur.length || new Set(ids).size !== ids.length || !ids.every((i) => cur.includes(i))) fail(400, 'order_mismatch', { message: 'The list must contain every item exactly once.' });
    await trx(getKnex(), async (t) => { for (const [i, id] of ids.entries()) await t(table).where({ id }).update({ position: i + 1 }); });
  };
  const orderBody = z.object({ ids: z.array(z.number().int()).max(1000) });
  route.put('/admin/providers/order', 'provider.write', async (req, res) => {
    const { ids } = validate(orderBody, req.body);
    await reorder('providers', {}, ids);
    audit(req.user.id, 'provider.reorder', null, { ids });
    res.json({ ok: true });
  });
  route.put('/admin/providers/:id/models/order', 'provider.write', async (req, res) => {
    const p = await get(req.params.id), { ids } = validate(orderBody, req.body);
    await reorder('models', { provider_id: p.id }, ids);
    audit(req.user.id, 'provider.models.reorder', p.name, { ids });
    res.json({ ok: true });
  });
  route.put('/admin/providers/:id', { perm: 'provider.write', stepup: true }, async (req, res) => {
    const p = await get(req.params.id), b = validate(body, req.body);
    await checkProviderUrl(b.type, b.config, lookup);
    // Secret, help text and the upload defaults are kept when the request leaves them out.
    await getKnex()('providers').where({ id: p.id }).update({
      name: b.name, type: b.type, config: JSON.stringify(b.config), enabled: +b.enabled, allowed_roles: JSON.stringify(b.allowedRoles),
      ...(b.secret && { secret_enc: encrypt(b.secret) }), ...(b.helpText != null && { help_text: b.helpText }),
      ...(b.fileUploads !== undefined && { file_uploads: +b.fileUploads }), ...(b.imageUploads !== undefined && { image_uploads: +b.imageUploads }),
    });
    audit(req.user.id, 'provider.update', b.name, { secretChanged: !!b.secret, helpTextChanged: b.helpText !== undefined && b.helpText !== (p.help_text || '') });
    res.json(await dto(await get(p.id)));
  });
  route.delete('/admin/providers/:id', { perm: 'provider.write', stepup: true }, async (req, res) => {
    const p = await get(req.params.id);
    await getKnex()('providers').where({ id: p.id }).del();
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
      const stored = await get(b.providerId), sc = JSON.parse(stored.config);
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
    const p = await get(req.params.id);
    try {
      const a = adapterFactory(p);
      const models = await a.listModels();
      res.json({ ok: true, models });
    } catch (e) { res.json({ ok: false, error: String(e.message).slice(0, 300) }); }
  });
  route.post('/admin/providers/:id/models', 'provider.write', async (req, res) => {
    const p = await get(req.params.id);
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
    // Adding a model that already exists updates it. Only the settings the request names are changed (the rest keep their values).
    const sent = (v) => v !== undefined;
    const fields = {
      label: b.label || b.modelId, enabled: +b.enabled, max_tokens: b.maxTokens, temperature: b.temperature, context_size: b.contextSize,
      ...(sent(b.thinkingMode) && { thinking_mode: mode, thinking_budget: budget }), ...(sent(b.autoContext) && { auto_context: +b.autoContext }),
      ...(sent(b.subagents) && { subagents: +b.subagents }),
      ...(sent(b.fileUploads) && { file_uploads: b.fileUploads == null ? null : +b.fileUploads }), ...(sent(b.imageUploads) && { image_uploads: b.imageUploads == null ? null : +b.imageUploads }),
      ...(sent(b.inputPrice) && { input_price: b.inputPrice ?? null }), ...(sent(b.outputPrice) && { output_price: b.outputPrice ?? null }),
      ...(sent(b.helpText) && { help_text: b.helpText ?? '' }),
    };
    await trx(getKnex(), async (t) => {
      const existing = await t('models').where({ provider_id: p.id, model_id: b.modelId }).first('id', 'position');
      if (existing) {
        await t('models').where({ id: existing.id }).update({ ...fields, ...(existing.position === 0 && { position: await nextPosition(t('models').where({ provider_id: p.id })) }) });
      } else {
        await t('models').insert({
          provider_id: p.id, model_id: b.modelId, thinking_mode: mode, thinking_budget: budget, auto_context: +(b.autoContext ?? false), subagents: +(b.subagents ?? true),
          file_uploads: b.fileUploads == null ? null : +b.fileUploads, image_uploads: b.imageUploads == null ? null : +b.imageUploads,
          input_price: b.inputPrice ?? null, output_price: b.outputPrice ?? null, help_text: b.helpText ?? '', ...fields,
          position: await nextPosition(t('models').where({ provider_id: p.id })), // new models go last
        });
      }
    });
    audit(req.user.id, 'provider.model.upsert', p.name, { model: b.modelId, enabled: b.enabled, ...(b.inputPrice !== undefined || b.outputPrice !== undefined ? { inputPrice: b.inputPrice, outputPrice: b.outputPrice } : {}) });
    res.json(await dto(await get(p.id)));
  });
  route.delete('/admin/models/:id', 'provider.write', async (req, res) => {
    await getKnex()('models').where({ id: intId(req.params.id) }).del();
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
    const rows = (await getKnex()('models as m').join('providers as p', 'p.id', 'm.provider_id').where({ 'm.enabled': 1, 'p.enabled': 1 })
      .orderBy([{ column: 'p.position' }, { column: 'p.id' }, { column: 'm.position' }, { column: 'm.id' }])
      .select('m.id', 'm.model_id as modelId', getKnex().raw('COALESCE(m.label, m.model_id) as label'), 'p.name as provider', 'p.allowed_roles as ar', 'm.thinking_mode as tm',
        'm.file_uploads as mf', 'm.image_uploads as mi', 'p.file_uploads as pf', 'p.image_uploads as pi', 'm.context_size as contextSize', 'm.auto_context as autoContext',
        'm.max_tokens as maxTokens', 'm.input_price as inputPrice', 'm.output_price as outputPrice', 'm.featured_badge_id as featuredBadgeId', 'p.help_text as help',
        'm.help_text as modelHelp', 'p.id as pid', 'p.type as ptype', 'p.config as pconfig', 'p.secret_enc as psecret'))
      .filter((m) => { const ar = JSON.parse(m.ar); return !ar.length || ar.some((x) => roles.includes(x)); });
    // thinkingCapable: what the provider reports (null = unknown). Only models that could think (admin-enabled) are probed.
    const capable = await Promise.all(rows.map((m) => m.tm === 'off' ? null : probeThinking(adapterFactory, { id: m.pid, type: m.ptype, config: m.pconfig, secret_enc: m.psecret }, m.modelId)));
    const showPricing = getSettings('general').showModelPricing; // prices are admin-entered; users only see them when this is on
    res.json({
      models: await Promise.all(rows.map(async ({ ar, tm, mf, mi, pf, pi, pid, ptype, pconfig, psecret, inputPrice, outputPrice, ...m }, i) => ({ ...m, autoContext: !!m.autoContext, contextSize: m.autoContext ? null : m.contextSize, ...(showPricing ? { inputPrice, outputPrice } : {}), supportsThinking: tm !== 'off' && capable[i] !== false, thinkingCapable: capable[i], supportsFiles: !!(mf ?? pf), supportsImages: !!(mi ?? pi), badges: await badgesFor(m.id) }))),
      defaults: getSettings('general').defaultModels,
    });
  });
  return r;
}

// What a model accepts: its own switch when set, otherwise its connection's.
export const uploadCaps = ({ model, provider }) => ({ files: !!(model.file_uploads ?? provider.file_uploads), images: !!(model.image_uploads ?? provider.image_uploads) });

export async function resolveModel(user, modelRowId) {
  const roles = userRoleNames(user.id);
  const k = getKnex();
  const row = await k('models as m').join('providers as p', 'p.id', 'm.provider_id').where({ 'm.id': modelRowId, 'm.enabled': 1, 'p.enabled': 1 }).first('m.*', 'p.id as pid');
  if (!row) return null;
  const p = await k('providers').where({ id: row.pid }).first();
  const ar = JSON.parse(p.allowed_roles);
  if (ar.length && !ar.some((x) => roles.includes(x))) return null;
  return { model: row, provider: p };
}
