import { McpClient, McpError, parseResult } from './client.js';
import { activeServers, headersOf } from './store.js';

const MAX_TOOLS_PER_SERVER = 50, MAX_TOOLS = 100, MAX_SCHEMA = 20_000, DISCOVER_MS = 8000, CALL_MS = 60_000;
export const MCP_PREFIX = 'mcp__';
const slug = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');

export const clientFor = (row, deps = {}) => new McpClient({ url: row.url, headers: headersOf(row), allowPrivate: !!row.allow_private && row.scope === 'tenant', ...deps });

// A tool is read-only only if the server says so (readOnlyHint) — and it is not also flagged destructive. Anything else is treated
// as able to change things: it is hidden in Plan mode and every call in Act mode needs the user's approval.
export const isReadOnly = (t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true;

const toDef = (server, tool, name) => {
  let params = tool.inputSchema && tool.inputSchema.type === 'object' ? tool.inputSchema : { type: 'object', properties: {} };
  if (JSON.stringify(params).length > MAX_SCHEMA) return null;
  params = { ...params, properties: params.properties || {} };
  return {
    name, mcp: true, server: server.name, tool: tool.name, mutating: !isReadOnly(tool), parameters: params,
    description: `[MCP server "${server.name}"] ${String(tool.description || tool.title || tool.name).slice(0, 1000)}`,
  };
};

// Connects to every MCP server the user has active and exposes their tools to one agent turn. Failures are reported, never fatal.
// Returns { defs: Map, call(name,args,signal), close(), problems: [{server,error}] }.
export async function openToolset(userId, { deps = {}, servers } = {}) {
  servers ??= await activeServers(userId);
  const defs = new Map(), clients = new Map(), problems = [];
  await Promise.all(servers.map(async (row) => {
    const c = clientFor(row, deps);
    try {
      await c.connect({ signal: AbortSignal.timeout(DISCOVER_MS) });
      const tools = (await c.listTools({ signal: AbortSignal.timeout(DISCOVER_MS) })).filter((t) => t && typeof t.name === 'string').slice(0, MAX_TOOLS_PER_SERVER);
      clients.set(row.id, c);
      row.__tools = tools;
    } catch (e) { problems.push({ server: row.name, error: e instanceof McpError ? e.message : 'Could not connect' }); await c.close(); }
  }));
  for (const row of servers) {
    for (const t of row.__tools || []) {
      if (defs.size >= MAX_TOOLS) break;
      let name = `${MCP_PREFIX}${slug(row.name)}__${slug(t.name)}`.slice(0, 64), n = 2;
      while (defs.has(name)) name = `${name.slice(0, 60)}_${n++}`;
      const d = toDef(row, t, name);
      if (d) { d.serverId = row.id; defs.set(name, d); }
    }
    delete row.__tools;
  }
  return {
    defs, problems,
    async call(name, args, signal) {
      const d = defs.get(name), c = d && clients.get(d.serverId);
      if (!c) return 'Error: that MCP tool is not available.';
      try {
        const r = parseResult(await c.callTool(d.tool, args && typeof args === 'object' ? args : {}, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)]) : AbortSignal.timeout(CALL_MS) }));
        // A result with images or audio comes back as an object; the caller decides whether it can keep them.
        return r.media.length ? r : r.text;
      }
      catch (e) { return `Error: ${e instanceof McpError ? e.message : 'the MCP call failed'}`; }
    },
    async close() { await Promise.all([...clients.values()].map((c) => c.close())); },
  };
}
