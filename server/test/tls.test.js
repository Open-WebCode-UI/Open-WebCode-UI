import { sqlDb } from './db-sql.js';
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { resolveTls, createServer, isLocalHost, tlsManagement, effectiveBaseUrl, setTlsRuntime } from '../src/tls.js';
import { freshDb, createApp, tmpDir, login } from './helpers.js';

import { config } from '../src/config.js';

const saved = { baseUrl: config.baseUrl };
afterEach(() => { config.baseUrl = saved.baseUrl; });
const get = (port, ca, p = '/api/public-config', host = 'localhost') => new Promise((resolve, reject) => {
  https.get({ host, port, path: p, ca, servername: 'localhost' }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ res, body: d })); }).on('error', reject);
});

describe('HTTPS for localhost', () => {
  it('recognizes local host names', () => {
    for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '::1']) expect(isLocalHost(h)).toBe(true);
    for (const h of ['example.com', 'localhost.evil.com', '10.0.0.5']) expect(isLocalHost(h)).toBe(false);
  });
  it('generates a persisted self-signed certificate valid for localhost, 127.0.0.1 and ::1', async () => {
    const dir = tmpDir('tls-');
    const t = await resolveTls({ baseUrl: 'https://localhost:3000', dataDir: dir, env: {} });
    expect(t.source).toBe('self-signed');
    const x = new X509Certificate(t.cert);
    expect(x.checkHost('localhost')).toBe('localhost'); expect(x.checkIP('127.0.0.1')).toBe('127.0.0.1'); expect(x.checkIP('::1')).toBe('::1');
    expect(x.checkHost('example.com')).toBeUndefined();
    expect(fs.statSync(path.join(dir, 'tls/localhost.key')).mode & 0o077).toBe(0); // private key is owner-only
    const again = await resolveTls({ baseUrl: 'https://127.0.0.1:3000', dataDir: dir, env: {} });
    expect(again.cert.equals(t.cert)).toBe(true); // reused, not regenerated
  });
  it('never self-signs for non-local names, behind a proxy, or when BASE_URL is http', async () => {
    const dir = tmpDir('tls-');
    expect(await resolveTls({ baseUrl: 'https://code.example.com', dataDir: dir, env: {} })).toBeNull();
    expect(await resolveTls({ baseUrl: 'https://localhost:3000', dataDir: dir, env: { TRUST_PROXY: '1' } })).toBeNull();
    expect(await resolveTls({ baseUrl: 'http://localhost:3000', dataDir: dir, env: {} })).toBeNull();
    expect(fs.existsSync(path.join(dir, 'tls'))).toBe(false);
  });
  it('uses a supplied certificate for any host name, and requires both files', async () => {
    const dir = tmpDir('tls-');
    const gen = await resolveTls({ baseUrl: 'https://localhost:3000', dataDir: dir, env: {} });
    const out = await resolveTls({ baseUrl: 'https://code.example.com', dataDir: dir, env: { TLS_CERT: path.join(dir, 'tls/localhost.crt'), TLS_KEY: path.join(dir, 'tls/localhost.key') } });
    expect(out.source).toBe('configured'); expect(out.cert.equals(gen.cert)).toBe(true);
    await expect(resolveTls({ baseUrl: 'https://x.test', dataDir: dir, env: { TLS_CERT: 'a' } })).rejects.toThrow(/both/);
  });
  it('serves the API over HTTPS with secure cookies, no HSTS pin on localhost, and the CSP upgrade directive', async () => {
    await freshDb();
    config.baseUrl = 'https://localhost:3000';
    const tls = await resolveTls({ baseUrl: config.baseUrl, dataDir: tmpDir('tls-'), env: {} });
    const server = await createServer(createApp(), tls);
    await new Promise((r) => server.listen(0, r));
    try {
      const { res, body } = await get(server.address().port, tls.cert);
      expect(res.statusCode).toBe(200); expect(JSON.parse(body).general.appName).toBeTruthy();
      expect(res.headers['strict-transport-security']).toBeUndefined();
      expect(res.headers['content-security-policy']).toContain('upgrade-insecure-requests');
      // a client that does not trust the certificate is refused (the cert is not silently accepted)
      await expect(get(server.address().port, undefined)).rejects.toThrow(/self[- ]signed|unable to verify/i);
    } finally { server.close(); }
  });
  it('does not send upgrade-insecure-requests over plain http, and uses HSTS only for real https hosts', async () => {
    await freshDb();
    config.baseUrl = 'http://localhost:3000';
    const { default: request } = await import('supertest');
    const plain = await request(createApp()).get('/api/public-config');
    expect(plain.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    config.baseUrl = 'https://code.example.com';
    const prod = await request(createApp()).get('/api/public-config');
    expect(prod.headers['strict-transport-security']).toMatch(/max-age=31536000/);
  });
});

describe('administrator-chosen HTTPS', () => {
  it('stays plain HTTP until chosen, then serves a self-signed certificate for the BASE_URL host plus localhost', async () => {
    const dir = tmpDir('tls-');
    expect(await resolveTls({ baseUrl: 'https://code.example.com', dataDir: dir, env: {}, choice: 'unset' })).toBeNull();
    expect(await resolveTls({ baseUrl: 'https://code.example.com', dataDir: dir, env: {}, choice: 'none' })).toBeNull();
    const t = await resolveTls({ baseUrl: 'http://code.example.com:3000', dataDir: dir, env: {}, choice: 'self-signed' });
    expect(t.source).toBe('self-signed');
    const x = new X509Certificate(t.cert);
    expect(x.checkHost('code.example.com')).toBe('code.example.com'); expect(x.checkHost('localhost')).toBe('localhost');
    const again = await resolveTls({ baseUrl: 'http://code.example.com:3000', dataDir: dir, env: {}, choice: 'self-signed' });
    expect(again.cert.equals(t.cert)).toBe(true);
    const moved = await resolveTls({ baseUrl: 'http://other.example.com', dataDir: dir, env: {}, choice: 'self-signed' });
    expect(new X509Certificate(moved.cert).checkHost('other.example.com')).toBe('other.example.com'); // host changed: reissued
  });
  it('supports an IP address host, and ignores the choice behind a proxy', async () => {
    const dir = tmpDir('tls-');
    const t = await resolveTls({ baseUrl: 'http://10.0.0.5:3000', dataDir: dir, env: {}, choice: 'self-signed' });
    expect(new X509Certificate(t.cert).checkIP('10.0.0.5')).toBe('10.0.0.5');
    expect(await resolveTls({ baseUrl: 'https://x.test', dataDir: dir, env: { TRUST_PROXY: '1' }, choice: 'self-signed' })).toBeNull();
  });
  it('knows who manages HTTPS and keeps BASE_URL in line with the scheme served', () => {
    expect(tlsManagement({ baseUrl: 'https://code.example.com', env: {} })).toBe('admin');
    expect(tlsManagement({ baseUrl: 'https://code.example.com', env: { TRUST_PROXY: '1' } })).toBe('proxy');
    expect(tlsManagement({ baseUrl: 'https://code.example.com', env: { TLS_CERT: 'a', TLS_KEY: 'b' } })).toBe('environment');
    expect(tlsManagement({ baseUrl: 'https://localhost:3000', env: {} })).toBe('environment');
    expect(effectiveBaseUrl('http://h.test:3000', true)).toBe('https://h.test:3000');
    expect(effectiveBaseUrl('https://h.test', false)).toBe('http://h.test');
    expect(effectiveBaseUrl('https://h.test', true)).toBe('https://h.test');
  });
});

describe('admin HTTPS API', () => {
  const setup = async () => {
    await freshDb(); config.baseUrl = 'http://code.example.com:3000'; setTlsRuntime({ https: false, source: null, managedBy: 'admin', cert: null });
    return login(createApp(), { username: 'adm', roles: ['administrator'] });
  };
  it('asks for a choice when nothing is configured, then saves self-signed with a certificate and flags a restart', async () => {
    const a = await setup();
    const first = (await a.get('/api/admin/tls')).body;
    expect(first).toMatchObject({ managedBy: 'admin', mode: 'unset', needsChoice: true, restartRequired: false, certificate: null });
    const r = await a.put('/api/admin/tls').send({ mode: 'self-signed' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: 'self-signed', needsChoice: false, restartRequired: true });
    expect(fs.existsSync(path.join(config.dataDir, 'tls/server.crt'))).toBe(true);
    expect(r.body.pendingCertificate.altNames.join()).toContain('code.example.com');
    const fp = r.body.pendingCertificate.fingerprint;
    const re = await a.post('/api/admin/tls/regenerate').send({});
    expect(re.body.pendingCertificate.fingerprint).not.toBe(fp);
    expect((await sqlDb().prepare("SELECT 1 FROM audit WHERE action='settings.tls.update'").get())).toBeTruthy();
  });
  it('choosing no HTTPS needs no restart while plain HTTP is running', async () => {
    const a = await setup();
    const r = await a.put('/api/admin/tls').send({ mode: 'none' });
    expect(r.body).toMatchObject({ mode: 'none', needsChoice: false, restartRequired: false });
    expect((await a.post('/api/admin/tls/regenerate').send({})).status).toBe(400);
  });
  it('rejects bad input, non-writers, and changes when the environment or a proxy decides', async () => {
    const a = await setup();
    expect((await a.put('/api/admin/tls').send({ mode: 'unset' })).status).toBe(400);
    expect((await a.put('/api/admin/tls').send({ mode: 'custom' })).status).toBe(400);
    const dev = await login(createApp(), { username: 'dev1', roles: ['developer'] });
    expect((await dev.put('/api/admin/tls').send({ mode: 'none' })).status).toBe(403);
    process.env.TRUST_PROXY = '1'; // a reverse proxy terminates TLS
    try {
      const r = await a.put('/api/admin/tls').send({ mode: 'none' });
      expect(r.status).toBe(409); expect(r.body.error).toBe('tls_managed_elsewhere');
      expect((await a.get('/api/admin/tls')).body).toMatchObject({ managedBy: 'proxy', mode: null, needsChoice: false });
    } finally { delete process.env.TRUST_PROXY; }
  });
});
