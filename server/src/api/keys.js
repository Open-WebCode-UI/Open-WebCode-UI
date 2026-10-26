import { getKnex } from '../db/index.js';
import { insertId } from '../db/dialect.js';
import { randomToken, sha256 } from '../crypto.js';

export const KEY_PREFIX = 'owui_';
const now = () => Math.floor(Date.now() / 1000);

export const hashKey = (key) => sha256(key);

// Keys carry 256 bits of randomness, so a plain SHA-256 is enough to store (there is nothing to brute-force, unlike a password).
export async function createKey(userId, { name, modelIds = null, expiresAt = null }) {
  const key = KEY_PREFIX + randomToken(32);
  const id = await insertId(getKnex()('api_keys'), {
    user_id: userId, name, prefix: key.slice(0, KEY_PREFIX.length + 4), key_hash: hashKey(key), model_ids: modelIds ? JSON.stringify(modelIds) : null, expires_at: expiresAt,
  });
  return { key, id };
}

export const keyDto = (r) => ({
  id: r.id, name: r.name, prefix: r.prefix, modelIds: r.model_ids ? JSON.parse(r.model_ids) : null,
  expiresAt: r.expires_at, lastUsedAt: r.last_used_at, createdAt: r.created_at, expired: !!r.expires_at && r.expires_at <= now(),
  ...(r.owner !== undefined ? { owner: { id: r.user_id, name: r.owner } } : {}),
});

export const ownKeys = async (userId) => (await getKnex()('api_keys').where({ user_id: userId }).orderBy('id')).map(keyDto);
export const allKeys = async () => (await getKnex()('api_keys as k').join('users as u', 'u.id', 'k.user_id').orderBy('k.id')
  .select('k.*', getKnex().raw('COALESCE(u.display_name, u.username, u.email) as owner'))).map(keyDto);

// The key row and its (enabled) owner for a presented secret, or null when it is unknown, expired, or its owner is disabled.
export async function lookupKey(presented) {
  if (typeof presented !== 'string' || !presented.startsWith(KEY_PREFIX) || presented.length > 200) return null;
  const k0 = getKnex();
  const k = await k0('api_keys').where({ key_hash: hashKey(presented) }).first();
  if (!k || (k.expires_at && k.expires_at <= now())) return null;
  const user = await k0('users').where({ id: k.user_id }).first();
  if (!user || user.disabled) return null;
  return { key: k, user };
}

export async function touchKey(k) {
  if (now() - (k.last_used_at || 0) > 60) await getKnex()('api_keys').where({ id: k.id }).update({ last_used_at: now() });
}
