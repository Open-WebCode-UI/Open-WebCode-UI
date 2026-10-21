import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from './http.js';

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
    return l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb') || l.startsWith('ff');
  }
  return true;
}

// SSRF guard for admin-supplied URLs. `lookup` is injectable for tests.
export async function assertSafeUrl(urlStr, { allowPrivate = false, lookup = dns.lookup } = {}) {
  let u;
  try { u = new URL(urlStr); } catch { throw new HttpError(400, 'invalid_url'); }
  if (!allowPrivate && u.protocol !== 'https:') throw new HttpError(400, 'https_required');
  if (!['https:', 'http:'].includes(u.protocol)) throw new HttpError(400, 'invalid_url');
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => { throw new HttpError(400, 'dns_failure'); });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new HttpError(400, 'private_address_blocked');
  return u;
}

export async function safeFetchText(urlStr, { allowPrivate = false, maxBytes = 1_000_000, timeoutMs = 10_000, fetchImpl = fetch, lookup, maxRedirects = 3 } = {}) {
  let url = urlStr;
  for (let i = 0; i <= maxRedirects; i++) {
    await assertSafeUrl(url, { allowPrivate, lookup });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { redirect: 'manual', signal: ctl.signal });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).toString(); continue; }
      if (!res.ok) throw new HttpError(502, 'fetch_failed', { status: res.status });
      const len = Number(res.headers.get('content-length') || 0);
      if (len > maxBytes) throw new HttpError(413, 'too_large');
      const reader = res.body.getReader();
      const chunks = []; let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) { ctl.abort(); throw new HttpError(413, 'too_large'); }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString('utf8');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(504, e.name === 'AbortError' ? 'fetch_timeout' : 'fetch_failed');
    } finally { clearTimeout(timer); }
  }
  throw new HttpError(502, 'too_many_redirects');
}
