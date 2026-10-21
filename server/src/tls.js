import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { X509Certificate } from 'node:crypto';
import selfsigned from 'selfsigned';

export const isLocalHost = (h) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(h).toLowerCase());

const bare = (h) => String(h).replace(/^\[|\]$/g, '');

// Who decides whether this server speaks HTTPS:
//   'environment' - TLS_CERT/TLS_KEY are set, or BASE_URL is https://localhost (auto self-signed development certificate)
//   'proxy'       - TRUST_PROXY is set: a reverse proxy terminates TLS and the server speaks plain HTTP to it
//   'admin'       - nothing is configured, so an administrator chooses (Admin > HTTPS): self-signed certificate or no HTTPS
export function tlsManagement({ baseUrl, env = process.env }) {
  if (env.TLS_CERT || env.TLS_KEY) return 'environment';
  const url = new URL(baseUrl);
  if (env.TRUST_PROXY !== undefined) return 'proxy';
  return url.protocol === 'https:' && isLocalHost(url.hostname) ? 'environment' : 'admin';
}

// Decides how the server should listen:
//   TLS_CERT + TLS_KEY (PEM file paths)  -> HTTPS with your certificate (any host name)
//   BASE_URL is https://localhost|127.0.0.1 and no cert supplied -> HTTPS with an auto-generated, persisted
//        self-signed localhost certificate (development convenience)
//   `choice` is 'self-signed' (the administrator's saved decision, only honored when nothing above or a proxy decides)
//        -> HTTPS with a persisted self-signed certificate for the BASE_URL host name
//   otherwise -> plain HTTP (an administrator has not chosen yet, chose no HTTPS, or TLS is terminated by a reverse proxy)
export async function resolveTls({ baseUrl, dataDir, env = process.env, choice = 'unset' }) {
  const url = new URL(baseUrl);
  if (env.TLS_CERT || env.TLS_KEY) {
    if (!env.TLS_CERT || !env.TLS_KEY) throw new Error('Set both TLS_CERT and TLS_KEY');
    return { cert: fs.readFileSync(env.TLS_CERT), key: fs.readFileSync(env.TLS_KEY), source: 'configured' };
  }
  if (url.protocol === 'https:' && isLocalHost(url.hostname) && env.TRUST_PROXY === undefined) {
    return ensureSelfSigned({ dataDir, hostnames: ['localhost'], name: 'localhost' });
  }
  if (choice === 'self-signed' && env.TRUST_PROXY === undefined) return ensureSelfSigned({ dataDir, hostnames: [url.hostname], name: 'server' });
  return null;
}

// Creates (or reuses) tls/<name>.crt|key. It is regenerated when missing, close to expiry, `force`d, or when it does not cover
// one of the host names. localhost, 127.0.0.1 and ::1 are always included so local access keeps working.
export async function ensureSelfSigned({ dataDir, hostnames, name, force = false }) {
  const dir = path.join(dataDir, 'tls');
  const crt = path.join(dir, `${name}.crt`), key = path.join(dir, `${name}.key`);
  const names = [...new Set(['localhost', '127.0.0.1', '::1', ...hostnames.map(bare)])];
  const covers = (pem) => { const x = new X509Certificate(pem); return names.every((n) => (net.isIP(n) ? x.checkIP(n) : x.checkHost(n))); };
  const reusable = !force && fs.existsSync(crt) && fs.existsSync(key) && (() => { const pem = fs.readFileSync(crt); return !certExpiresSoon(pem) && covers(pem); })();
  if (!reusable) {
    fs.mkdirSync(dir, { recursive: true });
    const pems = await selfsigned.generate([{ name: 'commonName', value: bare(hostnames[0]) }], {
      days: 825, keySize: 2048, algorithm: 'sha256',
      extensions: [{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: names.map((n) => (net.isIP(n) ? { type: 7, ip: n } : { type: 2, value: n })) }],
    });
    fs.writeFileSync(crt, pems.cert); fs.writeFileSync(key, pems.private, { mode: 0o600 });
  }
  return { cert: fs.readFileSync(crt), key: fs.readFileSync(key), source: 'self-signed', certFile: crt };
}

export function certInfo(pem) {
  const x = new X509Certificate(pem);
  return {
    subject: x.subject.replace(/\n/g, ', '), issuer: x.issuer.replace(/\n/g, ', '), selfSigned: x.subject === x.issuer,
    validFrom: new Date(x.validFrom).toISOString(), validTo: new Date(x.validTo).toISOString(),
    fingerprint: x.fingerprint256, altNames: (x.subjectAltName || '').split(/,\s*/).filter(Boolean),
  };
}

// What the running process actually did at startup (the saved choice only takes effect after a restart).
let runtime = { https: false, source: null, managedBy: 'admin', cert: null };
export const setTlsRuntime = (r) => { runtime = r; };
export const getTlsRuntime = () => runtime;

// Cookies, redirects, and SAML URLs follow the scheme actually served, so when an administrator decides the scheme the
// configured BASE_URL is brought in line with it (same host and port).
export function effectiveBaseUrl(baseUrl, https) {
  const u = new URL(baseUrl);
  if (u.protocol === (https ? 'https:' : 'http:')) return baseUrl;
  u.protocol = https ? 'https:' : 'http:';
  return u.toString().replace(/\/$/, '');
}

function certExpiresSoon(pem) {
  try { return Date.parse(new X509Certificate(pem).validTo) - Date.now() < 30 * 86400_000; } catch { return true; }
}

export function createServer(app, tls) {
  return tls ? https.createServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' }, app) : http.createServer(app);
}
