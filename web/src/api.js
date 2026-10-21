// Tiny fetch wrapper: same-origin cookies + CSRF header; errors carry the server's JSON body.
let csrf = '';
export const setCsrf = (t) => { csrf = t || ''; };
export const getCsrf = () => csrf;

// A signed-in user whose session has ended gets 401 'unauthenticated' from any call. The app registers a handler here that
// drops back to the sign-in page, instead of every screen failing quietly with empty lists and generic errors.
let onExpired = null;
export const setExpiredHandler = (fn) => { onExpired = fn; };
const noteExpiry = (status, body) => { if (status === 401 && body?.error === 'unauthenticated') onExpired?.(); };

export class ApiError extends Error {
  constructor(status, body) { super(body?.error || `HTTP ${status}`); this.status = status; this.body = body || {}; }
}

export async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) { noteExpiry(res.status, data); throw new ApiError(res.status, data); }
  return data;
}
export const get = (u) => api('GET', u);
export const post = (u, b = {}) => api('POST', u, b);
export const put = (u, b = {}) => api('PUT', u, b);
export const del = (u) => api('DELETE', u);

// Streams an SSE endpoint (POST), calling onEvent for each parsed event.
export async function streamPost(url, body, onEvent, signal) {
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', signal, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
  if (!res.ok) { const body = await res.json().catch(() => ({})); noteExpiry(res.status, body); throw new ApiError(res.status, body); }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    if (buf.length > 8_000_000) throw new Error('Stream event too large');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (line.startsWith('data: ')) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

// Uploads one file as the raw request body (binary safe, streamed by the browser, no base64).
export async function uploadFile(url, file) {
  const res = await fetch(url, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { noteExpiry(res.status, data); throw new ApiError(res.status, data); }
  return data;
}

// Where a stored attachment (for example an image a tool returned) can be shown from; same-origin, so the session cookie authorises it.
export const attachmentUrl = (id) => `/api/attachments/${encodeURIComponent(id)}`;

// Uploads one chat attachment (raw body, stored unattached until a message uses it). Resolves to { id, name, kind, size }.
export async function uploadAttachment(file) {
  const res = await fetch(`/api/attachments?name=${encodeURIComponent(file.name)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { noteExpiry(res.status, data); throw new ApiError(res.status, data); }
  return data;
}
