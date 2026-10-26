import express from 'express';
import { getKnex } from '../db/index.js';
import { defineRoutes, fail, validate, z } from '../http.js';
import { audit } from '../audit.js';
import { assertSafeUrl } from '../net-guard.js';
import { dto, userMcpAllowed, createServer, updateServer, deleteServer, listForUser, setUserDisabled } from '../mcp/store.js';
import { openToolset } from '../mcp/runtime.js';

const name = z.string().min(1).max(24);
const url = z.string().min(1).max(1000);
const headers = z.record(z.string(), z.string()).optional();

// Opens a connection, lists the tools, closes. Never echoes credentials; messages are the client's own short, safe strings.
async function probe(row, deps) {
  const ts = await openToolset(row.user_id ?? 0, { servers: [{ ...row }], deps });
  try {
    if (ts.problems.length) return { ok: false, error: ts.problems[0].error };
    return { ok: true, tools: [...ts.defs.values()].map((d) => ({ name: d.tool, description: d.description.replace(/^\[MCP server "[^"]*"\] /, '').slice(0, 200), readOnly: !d.mutating })) };
  } finally { await ts.close(); }
}

export function mcpRouter({ deps = {} } = {}) {
  const r = express.Router();
  const route = defineRoutes(r, '/api');
  const row = async (id) => { const n = Number(id); return (Number.isInteger(n) && await getKnex()('mcp_servers').where({ id: n }).first()) || fail(404, 'not_found'); };
  const mine = async (req) => { const s = await row(req.params.id); if (s.scope !== 'user' || s.user_id !== req.user.id) fail(404, 'not_found'); return s; };
  const requireOwnAllowed = () => { if (!userMcpAllowed()) fail(403, 'user_mcp_disabled', { message: 'Your administrator has turned off personal MCP servers.' }); };
  const publicUrl = async (u) => { await assertSafeUrl(u, { lookup: deps.lookup }).catch((e) => fail(400, e.message === 'private_address_blocked' ? 'private_address_blocked' : e.message)); };

  // ---- the signed-in user's view: organization servers (they may switch off) and their own
  route.get('/mcp/servers', 'mcp.use', async (req, res) => res.json(await listForUser(req.user.id)));
  // Switch a server on or off for yourself. organization servers are never changed for anyone else.
  route.put('/mcp/servers/:id/enabled', 'mcp.use', async (req, res) => {
    const { enabled } = validate(z.object({ enabled: z.boolean() }), req.body), s = await row(req.params.id);
    if (s.scope === 'tenant') { if (!s.enabled) fail(404, 'not_found'); await setUserDisabled(req.user.id, s.id, !enabled); }
    else if (s.user_id === req.user.id) await getKnex()('mcp_servers').where({ id: s.id }).update({ enabled: +enabled });
    else fail(404, 'not_found');
    audit(req.user.id, 'mcp.toggle', s.name, { enabled, scope: s.scope });
    res.json({ ok: true });
  });

  // ---- a user's own servers (public https hosts only)
  route.post('/mcp/my-servers', 'profile.mcp.edit', async (req, res) => {
    requireOwnAllowed();
    const b = validate(z.object({ name, url, headers, enabled: z.boolean().default(true) }), req.body);
    await publicUrl(b.url);
    const s = await createServer({ scope: 'user', userId: req.user.id, ...b });
    audit(req.user.id, 'mcp.user.create', s.name, { host: new URL(s.url).host });
    res.status(201).json(dto(s));
  });
  route.put('/mcp/my-servers/:id', 'profile.mcp.edit', async (req, res) => {
    requireOwnAllowed();
    const s = await mine(req), b = validate(z.object({ name: name.optional(), url: url.optional(), headers, enabled: z.boolean().optional() }), req.body);
    if (b.url) await publicUrl(b.url);
    const out = await updateServer(s, b);
    audit(req.user.id, 'mcp.user.update', out.row.name, { fields: Object.keys(b).filter((k) => k !== 'headers'), headersChanged: b.headers !== undefined });
    res.json({ ...dto(out.row), headersCleared: out.headersCleared });
  });
  route.delete('/mcp/my-servers/:id', 'profile.mcp.edit', async (req, res) => {
    const s = await mine(req); await deleteServer(s.id); audit(req.user.id, 'mcp.user.delete', s.name); res.json({ ok: true });
  });
  route.post('/mcp/my-servers/:id/test', 'profile.mcp.edit', async (req, res) => { requireOwnAllowed(); const s = await mine(req); await publicUrl(s.url); res.json(await probe(s, deps)); });

  // ---- organization servers (administrators)
  route.get('/admin/mcp-servers', 'mcp.read', async (_req, res) => res.json((await getKnex()('mcp_servers').where({ scope: 'tenant' }).orderBy('name')).map((s) => dto(s))));
  const tenantBody = z.object({ name, url, headers, enabled: z.boolean().default(true), allowPrivate: z.boolean().default(false) });
  const checkTenantUrl = async (u, allowPrivate) => { await assertSafeUrl(u, { allowPrivate, lookup: deps.lookup }).catch((e) => fail(400, e.message)); };
  route.post('/admin/mcp-servers', { perm: 'mcp.write', stepup: true }, async (req, res) => {
    const b = validate(tenantBody, req.body);
    await checkTenantUrl(b.url, b.allowPrivate);
    const s = await createServer({ scope: 'tenant', ...b });
    audit(req.user.id, 'mcp.tenant.create', s.name, { host: new URL(s.url).host, allowPrivate: b.allowPrivate });
    res.status(201).json(dto(s));
  });
  route.put('/admin/mcp-servers/:id', { perm: 'mcp.write', stepup: true }, async (req, res) => {
    const s = await row(req.params.id); if (s.scope !== 'tenant') fail(404, 'not_found');
    const b = validate(tenantBody.partial(), req.body);
    await checkTenantUrl(b.url ?? s.url, b.allowPrivate ?? !!s.allow_private);
    const out = await updateServer(s, b);
    audit(req.user.id, 'mcp.tenant.update', out.row.name, { fields: Object.keys(b).filter((k) => k !== 'headers'), headersChanged: b.headers !== undefined });
    res.json({ ...dto(out.row), headersCleared: out.headersCleared });
  });
  route.delete('/admin/mcp-servers/:id', { perm: 'mcp.write', stepup: true }, async (req, res) => {
    const s = await row(req.params.id); if (s.scope !== 'tenant') fail(404, 'not_found');
    await deleteServer(s.id); audit(req.user.id, 'mcp.tenant.delete', s.name); res.json({ ok: true });
  });
  route.post('/admin/mcp-servers/:id/test', 'mcp.write', async (req, res) => {
    const s = await row(req.params.id); if (s.scope !== 'tenant') fail(404, 'not_found');
    await checkTenantUrl(s.url, !!s.allow_private);
    res.json(await probe(s, deps));
  });
  return r;
}
