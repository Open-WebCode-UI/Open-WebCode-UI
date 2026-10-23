import express from 'express';
import { getDb } from '../db/index.js';
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
  const own = (req) => getDb().prepare('SELECT * FROM api_keys WHERE id=? AND user_id=?').get(req.params.id, req.user.id) || fail(404, 'not_found');
  const checkModels = async (user, ids) => { for (const id of ids ?? []) if (!await resolveModel(user, id)) fail(400, 'model_unavailable', { modelId: id }); };

  route.get('/api-keys', 'api.use', (req, res) => {
    const s = getSettings('api');
    res.json({ enabled: s.enabled, maxKeys: s.maxKeysPerUser, maxKeyDays: s.maxKeyDays, rateLimitPerMin: s.rateLimitPerMin, keys: ownKeys(req.user.id) });
  });
  // Creating a key hands out standing access without a login, so it needs a recent MFA check (step-up) like other sensitive changes.
  route.post('/api-keys', { perm: 'api.use', stepup: true }, async (req, res) => {
    const b = validate(keyBody, req.body), s = getSettings('api');
    if (getDb().prepare('SELECT COUNT(*) c FROM api_keys WHERE user_id=?').get(req.user.id).c >= s.maxKeysPerUser) fail(409, 'key_limit', { max: s.maxKeysPerUser });
    if (s.maxKeyDays && (!b.expiresInDays || b.expiresInDays > s.maxKeyDays)) fail(400, 'expiry_required', { maxDays: s.maxKeyDays });
    await checkModels(req.user, b.modelIds);
    const { key, id } = createKey(req.user.id, { name: b.name, modelIds: b.modelIds ?? null, expiresAt: b.expiresInDays ? Math.floor(Date.now() / 1000) + b.expiresInDays * DAY : null });
    audit(req.user.id, 'apikey.create', b.name, { id });
    res.status(201).json({ ...keyDto(getDb().prepare('SELECT * FROM api_keys WHERE id=?').get(id)), key }); // the only time the secret is shown
  });
  // The secret and the expiry cannot change (create a new key instead); a key can be renamed and re-scoped.
  route.put('/api-keys/:id', 'api.use', async (req, res) => {
    const k = own(req), b = validate(keyBody.omit({ expiresInDays: true }), req.body);
    await checkModels(req.user, b.modelIds);
    getDb().prepare('UPDATE api_keys SET name=?, model_ids=? WHERE id=?').run(b.name, b.modelIds ? JSON.stringify(b.modelIds) : null, k.id);
    audit(req.user.id, 'apikey.update', b.name, { id: k.id });
    res.json(keyDto(getDb().prepare('SELECT * FROM api_keys WHERE id=?').get(k.id)));
  });
  route.delete('/api-keys/:id', 'api.use', (req, res) => {
    const k = own(req);
    getDb().prepare('DELETE FROM api_keys WHERE id=?').run(k.id);
    audit(req.user.id, 'apikey.delete', k.name, { id: k.id });
    res.json({ ok: true });
  });

  route.get('/admin/api-keys', 'api.keys.read', (_req, res) => res.json(allKeys()));
  route.delete('/admin/api-keys/:id', 'api.keys.write', (req, res) => {
    const k = getDb().prepare('SELECT * FROM api_keys WHERE id=?').get(req.params.id) || fail(404, 'not_found');
    getDb().prepare('DELETE FROM api_keys WHERE id=?').run(k.id);
    audit(req.user.id, 'apikey.revoke', k.name, { id: k.id, owner: k.user_id });
    res.json({ ok: true });
  });

  route.get('/admin/api-settings', 'settings.read', (_req, res) => res.json(getSettings('api')));
  route.put('/admin/api-settings', { perm: 'settings.write', stepup: true }, (req, res) => {
    const before = getSettings('api'), saved = saveSettings('api', { ...before, ...validate(settingsBody, req.body) });
    audit(req.user.id, 'settings.api', null, { from: before, to: saved });
    res.json(saved);
  });
  return r;
}
