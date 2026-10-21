import { assertSafeUrl } from '../net-guard.js';

// Minimal MCP client for the Streamable HTTP transport (JSON-RPC over POST; replies are JSON or an SSE stream).
// Remote servers only: running a local (stdio) server would mean spawning arbitrary programs on the platform host.
export const PROTOCOL_VERSION = '2025-06-18';
const MAX_BODY = 2_000_000;
const RESERVED = new Set(['host', 'content-length', 'content-type', 'accept', 'connection', 'transfer-encoding', 'mcp-session-id', 'mcp-protocol-version', 'cookie', 'upgrade', 'te', 'expect']);

export class McpError extends Error { constructor(message, extra = {}) { super(message); this.name = 'McpError'; Object.assign(this, extra); } }

// Auth headers an administrator or user supplies for a server. Returns a clean object or throws a message fit for the UI.
export function cleanHeaders(h) {
  if (h == null) return {};
  if (typeof h !== 'object' || Array.isArray(h)) throw new McpError('Headers must be an object');
  const out = {}; const entries = Object.entries(h);
  if (entries.length > 10) throw new McpError('At most 10 headers');
  for (const [k, v] of entries) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(k)) throw new McpError(`Invalid header name "${k}"`);
    if (RESERVED.has(k.toLowerCase())) throw new McpError(`Header "${k}" is managed by the platform`);
    if (typeof v !== 'string' || v.length > 2000 || /[\r\n\0]/.test(v)) throw new McpError(`Invalid value for header "${k}"`);
    out[k] = v;
  }
  return out;
}

async function readCapped(res) {
  const reader = res.body.getReader(); const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BODY) { try { await reader.cancel(); } catch { /* closing anyway */ } throw new McpError('Response too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// The JSON-RPC message with `id` out of a response body that is either plain JSON or an SSE stream of messages.
function pickMessage(text, contentType, id) {
  const msgs = [];
  if (contentType.includes('text/event-stream')) {
    for (const ev of text.split(/\r?\n\r?\n/)) {
      const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (data) { try { msgs.push(JSON.parse(data)); } catch { /* ignore malformed event */ } }
    }
  } else { try { const j = JSON.parse(text); Array.isArray(j) ? msgs.push(...j) : msgs.push(j); } catch { throw new McpError('Invalid response from MCP server'); } }
  const m = msgs.find((x) => x && x.id === id && ('result' in x || 'error' in x));
  if (!m) throw new McpError('No reply from MCP server');
  return m;
}

export class McpClient {
  constructor({ url, headers = {}, allowPrivate = false, fetchImpl = fetch, lookup, timeoutMs = 15_000, clientName = 'agentic-coding-platform' }) {
    Object.assign(this, { url, headers, allowPrivate, fetchImpl, lookup, timeoutMs, clientName, nextId: 1, sessionId: null, version: PROTOCOL_VERSION, ready: false });
  }
  async #post(body, { signal } = {}) {
    await assertSafeUrl(this.url, { allowPrivate: this.allowPrivate, lookup: this.lookup }); // re-checked on every call (DNS can change)
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    signal?.addEventListener('abort', () => ctl.abort(), { once: true });
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST', redirect: 'error', signal: ctl.signal, body: JSON.stringify(body),
        headers: { ...this.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(this.ready ? { 'MCP-Protocol-Version': this.version } : {}), ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}) },
      });
      const sid = res.headers.get('mcp-session-id'); if (sid) this.sessionId = sid;
      if (res.status === 401 || res.status === 403) throw new McpError('The MCP server rejected the credentials');
      if (!res.ok && res.status !== 202) throw new McpError(`MCP server returned HTTP ${res.status}`);
      if (res.status === 202) return null;
      return pickMessage(await readCapped(res), res.headers.get('content-type') || '', body.id);
    } catch (e) {
      if (e instanceof McpError) throw e;
      throw new McpError(e.name === 'AbortError' ? 'The MCP server timed out' : e.code === 'private_address_blocked' || e.message === 'private_address_blocked' ? 'That address is not allowed' : e.message === 'https_required' ? 'MCP servers must use https' : `Could not reach the MCP server (${String(e.message || e.name).slice(0, 80)})`);
    } finally { clearTimeout(timer); }
  }
  async request(method, params, opts) {
    const id = this.nextId++;
    const m = await this.#post({ jsonrpc: '2.0', id, method, params }, opts);
    if (m.error) throw new McpError(String(m.error.message || 'MCP error').slice(0, 300), { code: m.error.code });
    return m.result;
  }
  async connect(opts) {
    const r = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: this.clientName, version: '1.0.0' } }, opts);
    if (r?.protocolVersion) this.version = r.protocolVersion;
    this.ready = true;
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }, opts).catch(() => {});
    return { name: r?.serverInfo?.name || '', version: r?.serverInfo?.version || '' };
  }
  async listTools(opts) {
    const tools = []; let cursor;
    for (let page = 0; page < 5; page++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {}, opts);
      tools.push(...(r?.tools || []));
      if (!r?.nextCursor) break;
      cursor = r.nextCursor;
    }
    return tools;
  }
  callTool(name, args, opts) { return this.request('tools/call', { name, arguments: args || {} }, opts); }
  async close() {
    if (!this.sessionId) return;
    try { await this.fetchImpl(this.url, { method: 'DELETE', redirect: 'error', headers: { ...this.headers, 'Mcp-Session-Id': this.sessionId }, signal: AbortSignal.timeout(3000) }); } catch { /* best effort */ }
  }
}

// Tool result -> { text, media }. `text` is what the model reads; image/audio parts are pulled out into `media` ({ kind, mime, data }),
// and `textWithPlaceholders` is the same text with a note where each of them was, for when they cannot be kept or shown.
export function parseResult(r, cap = 20_000) {
  const parts = [], marked = [], media = [];
  for (const c of r?.content || []) {
    if (c.type === 'text') { const t = String(c.text ?? ''); parts.push(t); marked.push(t); }
    else if (c.type === 'image' || c.type === 'audio') {
      marked.push(`[${c.type} content omitted]`);
      if (typeof c.data === 'string' && c.data) media.push({ kind: c.type, mime: String(c.mimeType || ''), data: Buffer.from(c.data, 'base64') });
    }
    else {
      const t = c.type === 'resource' ? (c.resource?.text != null ? String(c.resource.text) : `[resource ${c.resource?.uri || ''}]`) : c.type === 'resource_link' ? `[link ${c.uri || ''}]` : null;
      if (t != null) { parts.push(t); marked.push(t); }
    }
  }
  if (!parts.length && !marked.length && r?.structuredContent) { const t = JSON.stringify(r.structuredContent); parts.push(t); marked.push(t); }
  const finish = (list) => {
    let text = list.join('\n');
    if (text.length > cap) text = `${text.slice(0, cap)}\n[truncated]`;
    return r?.isError ? `Error: ${text || 'the tool reported an error'}` : text || '(no output)';
  };
  return { text: finish(parts), textWithPlaceholders: finish(marked), media };
}

// Text only: binary content is replaced by a placeholder.
export const resultText = (r, cap) => parseResult(r, cap).textWithPlaceholders;
