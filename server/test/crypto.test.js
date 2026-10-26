import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { encrypt, decrypt, redact, safeEqual } from '../src/crypto.js';
import { freshDb, createApp, login, addProvider, request } from './helpers.js';

describe('crypto', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encrypt('hello'), b = encrypt('hello');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe('hello');
  });
  it('detects tampering and wrong keys', () => {
    const parts = encrypt('secret').split(':');
    const ct = Buffer.from(parts[3], 'base64'); ct[0] ^= 1; parts[3] = ct.toString('base64');
    expect(() => decrypt(parts.join(':'))).toThrow();
    expect(() => decrypt(encrypt('x'), crypto.randomBytes(32))).toThrow();
    expect(() => decrypt('garbage')).toThrow();
  });
  it('redacts sensitive keys recursively', () => {
    expect(redact({ a: 1, apiKey: 'x', nested: { password: 'p', ok: 2 }, list: [{ token: 't' }] }))
      .toEqual({ a: 1, apiKey: '[REDACTED]', nested: { password: '[REDACTED]', ok: 2 }, list: [{ token: '[REDACTED]' }] });
  });
  it('safeEqual', () => { expect(safeEqual('a', 'a')).toBe(true); expect(safeEqual('a', 'ab')).toBe(false); });
  it('never returns provider secrets from the API', async () => {
    await freshDb();
    const app = createApp();
    const admin = await login(app, { username: 'adm', roles: ['administrator'] });
    await addProvider();
    const res = await admin.get('/api/admin/providers');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('"k"');
    expect(res.body[0].secret).toBe('••••••••');
    expect(res.body[0]).not.toHaveProperty('secret_enc');
  });
});
