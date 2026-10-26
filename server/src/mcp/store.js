import { getKnex } from '../db/index.js';
import { trx, insertId } from '../db/dialect.js';
import { encrypt, decrypt } from '../crypto.js';
import { HttpError } from '../http.js';
import { getSettings } from '../settings.js';
import { cleanHeaders, McpError } from './client.js';

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
// Administrators can disallow personal MCP servers for everyone (Admin → MCP servers).
export const userMcpAllowed = () => !!getSettings('general').userMcpAllowed;
export const MAX_USER_SERVERS = 10, MAX_TENANT_SERVERS = 50;

export const headersOf = (row) => (row.headers_enc ? JSON.parse(decrypt(row.headers_enc)) : {});
// Header values are credentials: they are never returned, only their names.
export const dto = (row, extra = {}) => ({
  id: row.id, scope: row.scope, name: row.name, url: row.url, enabled: !!row.enabled, allowPrivate: !!row.allow_private,
  headerNames: row.headers_enc ? Object.keys(headersOf(row)) : [], ...extra,
});
export const validateHeaders = (h) => { try { return cleanHeaders(h); } catch (e) { if (e instanceof McpError) throw new HttpError(400, 'invalid_headers', { message: e.message }); throw e; } };

const sameOrigin = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };

// Rows a user's agent may use right now: enabled tenant servers they have not switched off, plus their own enabled servers
// (only while personal servers are allowed).
export async function activeServers(userId) {
  const allowOwn = userMcpAllowed();
  return getKnex()('mcp_servers as s').where('s.enabled', 1)
    .where((q) => { q.where('s.scope', 'tenant'); if (allowOwn) q.orWhere('s.user_id', userId); })
    .whereNotExists(function () { this.select(getKnex().raw('1')).from('mcp_user_prefs as p').where('p.user_id', userId).whereRaw('p.server_id = s.id').where('p.disabled', 1); })
    .orderBy([{ column: 's.scope' }, { column: 's.name' }]).select('s.*');
}

export async function listForUser(userId) {
  const k = getKnex();
  const off = new Set((await k('mcp_user_prefs').where({ user_id: userId, disabled: 1 }).select('server_id')).map((r) => r.server_id));
  return {
    ownAllowed: userMcpAllowed(),
    tenant: (await k('mcp_servers').where({ scope: 'tenant', enabled: 1 }).orderBy('name')).map((r) => dto(r, { disabledByMe: off.has(r.id) })),
    own: (await k('mcp_servers').where({ scope: 'user', user_id: userId }).orderBy('name')).map((r) => dto(r)),
  };
}

// The servers that compete for a name: a user's own, or the organization's.
const sameScope = (q, scope, userId) => (scope === 'user' ? q.where({ scope: 'user', user_id: userId }) : q.where({ scope: 'tenant' }));

export async function createServer({ scope, userId = null, name, url, headers, enabled = true, allowPrivate = false }) {
  const k = getKnex();
  if (!NAME_RE.test(name)) throw new HttpError(400, 'invalid_name', { message: 'Use 1-24 lowercase letters, digits, and dashes.' });
  const limit = scope === 'user' ? MAX_USER_SERVERS : MAX_TENANT_SERVERS;
  const count = (await sameScope(k('mcp_servers'), scope, userId).count({ c: '*' }).first()).c;
  if (count >= limit) throw new HttpError(400, 'too_many_servers');
  if (await sameScope(k('mcp_servers'), scope, userId).where({ name }).first('id')) throw new HttpError(409, 'name_taken');
  const h = validateHeaders(headers);
  const id = await insertId(k('mcp_servers'), { scope, user_id: userId, name, url, headers_enc: Object.keys(h).length ? encrypt(JSON.stringify(h)) : null, enabled: +enabled, allow_private: +allowPrivate });
  return k('mcp_servers').where({ id }).first();
}

// `headers`: undefined keeps the stored ones, {} clears them, an object replaces them. Stored credentials are never sent to a
// different origin than the one they were saved for, so changing the host without re-entering them drops them.
export async function updateServer(row, { name, url, headers, enabled, allowPrivate }) {
  const k = getKnex();
  if (name !== undefined && name !== row.name) {
    if (!NAME_RE.test(name)) throw new HttpError(400, 'invalid_name', { message: 'Use 1-24 lowercase letters, digits, and dashes.' });
    if (await sameScope(k('mcp_servers'), row.scope, row.user_id).where({ name }).whereNot({ id: row.id }).first('id')) throw new HttpError(409, 'name_taken');
  }
  let enc = row.headers_enc, cleared = false;
  if (headers !== undefined) { const h = validateHeaders(headers); enc = Object.keys(h).length ? encrypt(JSON.stringify(h)) : null; }
  else if (url !== undefined && !sameOrigin(url, row.url) && enc) { enc = null; cleared = true; }
  await k('mcp_servers').where({ id: row.id }).update({
    name: name ?? row.name, url: url ?? row.url, headers_enc: enc, enabled: enabled == null ? row.enabled : +enabled, allow_private: allowPrivate == null ? row.allow_private : +allowPrivate,
  });
  return { row: await k('mcp_servers').where({ id: row.id }).first(), headersCleared: cleared };
}

export const deleteServer = (id) => getKnex()('mcp_servers').where({ id }).del();
export async function setUserDisabled(userId, serverId, disabled) {
  await getKnex()('mcp_user_prefs').insert({ user_id: userId, server_id: serverId, disabled: +disabled }).onConflict(['user_id', 'server_id']).merge();
}
