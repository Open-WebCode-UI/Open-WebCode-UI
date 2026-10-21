import { getDb } from '../db/index.js';
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
export function activeServers(userId) {
  return getDb().prepare(`SELECT s.* FROM mcp_servers s
    WHERE s.enabled=1 AND (s.scope='tenant' OR (s.user_id=? AND ?))
      AND NOT EXISTS (SELECT 1 FROM mcp_user_prefs p WHERE p.user_id=? AND p.server_id=s.id AND p.disabled=1)
    ORDER BY s.scope, s.name`).all(userId, +userMcpAllowed(), userId);
}

export function listForUser(userId) {
  const db = getDb();
  const off = new Set(db.prepare('SELECT server_id FROM mcp_user_prefs WHERE user_id=? AND disabled=1').all(userId).map((r) => r.server_id));
  return {
    ownAllowed: userMcpAllowed(),
    tenant: db.prepare("SELECT * FROM mcp_servers WHERE scope='tenant' AND enabled=1 ORDER BY name").all().map((r) => dto(r, { disabledByMe: off.has(r.id) })),
    own: db.prepare("SELECT * FROM mcp_servers WHERE scope='user' AND user_id=? ORDER BY name").all(userId).map((r) => dto(r)),
  };
}

export function createServer({ scope, userId = null, name, url, headers, enabled = true, allowPrivate = false }) {
  const db = getDb();
  if (!NAME_RE.test(name)) throw new HttpError(400, 'invalid_name', { message: 'Use 1-24 lowercase letters, digits, and dashes.' });
  const limit = scope === 'user' ? MAX_USER_SERVERS : MAX_TENANT_SERVERS;
  const count = scope === 'user' ? db.prepare("SELECT COUNT(*) c FROM mcp_servers WHERE scope='user' AND user_id=?").get(userId).c : db.prepare("SELECT COUNT(*) c FROM mcp_servers WHERE scope='tenant'").get().c;
  if (count >= limit) throw new HttpError(400, 'too_many_servers');
  const taken = scope === 'user' ? db.prepare("SELECT 1 FROM mcp_servers WHERE scope='user' AND user_id=? AND name=?").get(userId, name) : db.prepare("SELECT 1 FROM mcp_servers WHERE scope='tenant' AND name=?").get(name);
  if (taken) throw new HttpError(409, 'name_taken');
  const h = validateHeaders(headers);
  const id = Number(db.prepare('INSERT INTO mcp_servers (scope,user_id,name,url,headers_enc,enabled,allow_private) VALUES (?,?,?,?,?,?,?)')
    .run(scope, userId, name, url, Object.keys(h).length ? encrypt(JSON.stringify(h)) : null, +enabled, +allowPrivate).lastInsertRowid);
  return db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(id);
}

// `headers`: undefined keeps the stored ones, {} clears them, an object replaces them. Stored credentials are never sent to a
// different origin than the one they were saved for, so changing the host without re-entering them drops them.
export function updateServer(row, { name, url, headers, enabled, allowPrivate }) {
  const db = getDb();
  if (name !== undefined && name !== row.name) {
    if (!NAME_RE.test(name)) throw new HttpError(400, 'invalid_name', { message: 'Use 1-24 lowercase letters, digits, and dashes.' });
    const clash = row.scope === 'user' ? db.prepare("SELECT 1 FROM mcp_servers WHERE scope='user' AND user_id=? AND name=? AND id<>?").get(row.user_id, name, row.id) : db.prepare("SELECT 1 FROM mcp_servers WHERE scope='tenant' AND name=? AND id<>?").get(name, row.id);
    if (clash) throw new HttpError(409, 'name_taken');
  }
  let enc = row.headers_enc, cleared = false;
  if (headers !== undefined) { const h = validateHeaders(headers); enc = Object.keys(h).length ? encrypt(JSON.stringify(h)) : null; }
  else if (url !== undefined && !sameOrigin(url, row.url) && enc) { enc = null; cleared = true; }
  db.prepare('UPDATE mcp_servers SET name=?, url=?, headers_enc=?, enabled=?, allow_private=? WHERE id=?')
    .run(name ?? row.name, url ?? row.url, enc, enabled == null ? row.enabled : +enabled, allowPrivate == null ? row.allow_private : +allowPrivate, row.id);
  return { row: db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(row.id), headersCleared: cleared };
}

export const deleteServer = (id) => getDb().prepare('DELETE FROM mcp_servers WHERE id=?').run(id);
export function setUserDisabled(userId, serverId, disabled) {
  getDb().prepare('INSERT INTO mcp_user_prefs (user_id, server_id, disabled) VALUES (?,?,?) ON CONFLICT(user_id, server_id) DO UPDATE SET disabled=excluded.disabled').run(userId, serverId, +disabled);
}
