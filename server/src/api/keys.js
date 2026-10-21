import { getDb } from '../db/index.js';
import { randomToken, sha256 } from '../crypto.js';

export const KEY_PREFIX = 'owui_';
const now = () => Math.floor(Date.now() / 1000);

export const hashKey = (key) => sha256(key);

// Keys carry 256 bits of randomness, so a plain SHA-256 is enough to store (there is nothing to brute-force, unlike a password).
export function createKey(userId, { name, modelIds = null, expiresAt = null }) {
  const key = KEY_PREFIX + randomToken(32);
  const id = Number(getDb().prepare('INSERT INTO api_keys (user_id, name, prefix, key_hash, model_ids, expires_at) VALUES (?,?,?,?,?,?)')
    .run(userId, name, key.slice(0, KEY_PREFIX.length + 4), hashKey(key), modelIds ? JSON.stringify(modelIds) : null, expiresAt).lastInsertRowid);
  return { key, id };
}

export const keyDto = (r) => ({
  id: r.id, name: r.name, prefix: r.prefix, modelIds: r.model_ids ? JSON.parse(r.model_ids) : null,
  expiresAt: r.expires_at, lastUsedAt: r.last_used_at, createdAt: r.created_at, expired: !!r.expires_at && r.expires_at <= now(),
  ...(r.owner !== undefined ? { owner: { id: r.user_id, name: r.owner } } : {}),
});

export const ownKeys = (userId) => getDb().prepare('SELECT * FROM api_keys WHERE user_id=? ORDER BY id').all(userId).map(keyDto);
export const allKeys = () => getDb().prepare(`SELECT k.*, COALESCE(u.display_name, u.username, u.email) owner FROM api_keys k JOIN users u ON u.id=k.user_id ORDER BY k.id`).all().map(keyDto);

// The key row and its (enabled) owner for a presented secret, or null when it is unknown, expired, or its owner is disabled.
export function lookupKey(presented) {
  if (typeof presented !== 'string' || !presented.startsWith(KEY_PREFIX) || presented.length > 200) return null;
  const db = getDb();
  const k = db.prepare('SELECT * FROM api_keys WHERE key_hash=?').get(hashKey(presented));
  if (!k || (k.expires_at && k.expires_at <= now())) return null;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(k.user_id);
  if (!user || user.disabled) return null;
  return { key: k, user };
}

export function touchKey(k) {
  if (now() - (k.last_used_at || 0) > 60) getDb().prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(now(), k.id);
}
