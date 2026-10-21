import crypto from 'node:crypto';
import { config } from './config.js';

// Format: v1:<iv b64>:<tag b64>:<ciphertext b64>. Version prefix permits key rotation.
export function encrypt(plain, key = config.encryptionKey) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(payload, key = config.encryptionKey) {
  const [v, iv, tag, ct] = String(payload).split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Invalid ciphertext');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export const maskSecret = (s) => (s ? '••••••••' : '');

const REDACT = /(api[_-]?key|secret|password|token|authorization|private[_-]?key)/i;
export function redact(obj) {
  if (Array.isArray(obj)) return obj.map(redact);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, REDACT.test(k) ? '[REDACTED]' : redact(v)]));
  }
  return obj;
}
