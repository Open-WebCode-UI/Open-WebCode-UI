import express from 'express';
import { getKnex } from '../db/index.js';
import { defineRoutes, fail, validate, z } from '../http.js';
import { audit } from '../audit.js';
import { getSettings, saveSettings } from '../settings.js';
import { createKey, ownKeys, allKeys, keyDto } from '../api/keys.js';
import { resolveModel } from './providers.js';

const DAY = 86400;
const keyBody = z.object({
  name: z.string().trim().min(1).max(80),
  modelIds: z.array(z.number().int()).min(1).max(200).nullable().optional(), // null/omitted = every model the owner may use
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
});
const settingsBody = z.object({
  enabled: z.boolean().optional(), maxKeysPerUser: z.number().int().min(1).max(100).optional(),
  rateLimitPerMin: z.number().int().min(1).max(100000).optional(), maxKeyDays: z.number().int().min(0).max(3650).optional(),
});

// Session-authenticated management of API keys. (The keys themselves authenticate /v1; see v1.js.)
export function apiKeysRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/api');
  const intId = (v) => { const n = Number(v); return Number.isInteger(n) ? n : fail(404, 'not_found'); };
  const own = async (req) => (await getKnex()('api_keys').where({ id: intId(req.params.id), user_id: req.user.id }).first()) || fail(404, 'not_found');
  const byId = (id) => getKnex()('api_keys').where({ id }).first();
  const checkModels = async (user, ids) => { for (const id of ids ?? []) if (!await resolveModel(user, id)) fail(400, 'model_unavailable', { modelId: id }); };

  route.get('/api-keys', 'api.use', async (req, res) => {
    const s = getSettings('api');
    res.json({ enabled: s.enabled, maxKeys: s.maxKeysPerUser, maxKeyDays: s.maxKeyDays, rateLimitPerMin: s.rateLimitPerMin, keys: await ownKeys(req.user.id) });
  });
  // Creating a key hands out standing access without a login, so it needs a recent MFA check (step-up) like other sensitive changes.
  route.post('/api-keys', { perm: 'api.use', stepup: true }, async (req, res) => {
    const b = validate(keyBody, req.body), s = getSettings('api');
    if ((await getKnex()('api_keys').where({ user_id: req.user.id }).count({ c: '*' }).first()).c >= s.maxKeysPerUser) fail(409, 'key_limit', { max: s.maxKeysPerUser });
    if (s.maxKeyDays && (!b.expiresInDays || b.expiresInDays > s.maxKeyDays)) fail(400, 'expiry_required', { maxDays: s.maxKeyDays });
    await checkModels(req.user, b.modelIds);
    const { key, id } = await createKey(req.user.id, { name: b.name, modelIds: b.modelIds ?? null, expiresAt: b.expiresInDays ? Math.floor(Date.now() / 1000) + b.expiresInDays * DAY : null });
    await audit(req.user.id, 'apikey.create', b.name, { id });
    res.status(201).json({ ...keyDto(await byId(id)), key }); // the only time the secret is shown
  });
  // The secret and the expiry cannot change (create a new key instead); a key can be renamed and re-scoped.
  route.put('/api-keys/:id', 'api.use', async (req, res) => {
    const k = await own(req), b = validate(keyBody.omit({ expiresInDays: true }), req.body);
    await checkModels(req.user, b.modelIds);
    await getKnex()('api_keys').where({ id: k.id }).update({ name: b.name, model_ids: b.modelIds ? JSON.stringify(b.modelIds) : null });
    await audit(req.user.id, 'apikey.update', b.name, { id: k.id });
    res.json(keyDto(await byId(k.id)));
  });
  route.delete('/api-keys/:id', 'api.use', async (req, res) => {
    const k = await own(req);
    await getKnex()('api_keys').where({ id: k.id }).del();
    await audit(req.user.id, 'apikey.delete', k.name, { id: k.id });
    res.json({ ok: true });
  });

  route.get('/admin/api-keys', 'api.keys.read', async (_req, res) => res.json(await allKeys()));
  route.delete('/admin/api-keys/:id', 'api.keys.write', async (req, res) => {
    const k = (await byId(intId(req.params.id))) || fail(404, 'not_found');
    await getKnex()('api_keys').where({ id: k.id }).del();
    await audit(req.user.id, 'apikey.revoke', k.name, { id: k.id, owner: k.user_id });
    res.json({ ok: true });
  });

  route.get('/admin/api-settings', 'settings.read', (_req, res) => res.json(getSettings('api')));
  route.put('/admin/api-settings', { perm: 'settings.write', stepup: true }, async (req, res) => {
    const before = getSettings('api'), saved = await saveSettings('api', { ...before, ...validate(settingsBody, req.body) });
    await audit(req.user.id, 'settings.api', null, { from: before, to: saved });
    res.json(saved);
  });
  return r;
}
