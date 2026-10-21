import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getSettings } from './settings.js';
import { userRoleNames } from './auth/rbac.js';
import { activeServers } from './mcp/store.js';
import { activeScopes } from './memory.js';
import { listCheckpoints } from './workspace/checkpoints.js';

export const STATUS_RE = /^\/status\s*$/i;
const SKIP = new Set(['node_modules', '.git']);

function countFiles(dir, limit = 5000) {
  let files = 0, bytes = 0, capped = false;
  const walk = (d, depth) => {
    if (depth > 20 || capped) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink() || SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else { files += 1; try { bytes += fs.statSync(p).size; } catch { /* vanished */ } if (files >= limit) { capped = true; return; } }
    }
  };
  try { walk(dir, 0); } catch { /* unreadable project folder */ }
  return { files, bytes, capped };
}
const gitBranch = (dir) => { try { const h = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim(); return h.startsWith('ref: refs/heads/') ? h.slice(16) : `detached at ${h.slice(0, 8)}`; } catch { return null; } };

// What /status shows: the connection (session, model server), the server, the user, and the project. Nothing secret is included.
export async function buildStatus({ req, project = null, rm = null, adapter = null }) {
  const u = req.user, s = req.session, general = getSettings('general'), sec = getSettings('security');
  const now = Math.floor(Date.now() / 1000);
  let reachable = null;
  if (adapter?.listModels) {
    reachable = await Promise.race([adapter.listModels().then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 3000))]);
  }
  const status = {
    connection: {
      status: 'connected', signedInVia: u.source === 'saml' ? 'Single sign-on (SAML)' : 'Local account',
      mfaVerified: !!s?.mfa_satisfied, sessionStartedAt: s?.created_at ?? null,
      sessionExpiresAt: s ? Math.min(s.created_at + sec.sessionAbsoluteSec, s.last_seen + sec.sessionIdleSec) : null,
      now, model: rm ? { provider: rm.provider.name, type: rm.provider.type, model: rm.model.label || rm.model.model_id, reachable } : null,
    },
    server: { name: general.appName, url: config.baseUrl, secure: config.baseUrl.startsWith('https://'), shell: general.execMode === 'workspace_shell' ? 'enabled' : 'files only' },
    user: { displayName: u.display_name || u.username || u.email, username: u.username || null, email: u.email || null, roles: userRoleNames(u.id), mustChangePassword: !!u.must_change_password },
    project: null,
    features: { mcpServers: activeServers(u.id).length, memory: activeScopes(u.id, project?.id) },
  };
  if (project) {
    const f = countFiles(project.dir);
    status.project = { id: project.id, name: project.name, files: f.files, filesCapped: f.capped, sizeBytes: f.bytes, gitBranch: gitBranch(project.dir), checkpoints: (await listCheckpoints(project.id, project.dir).catch(() => [])).length, createdAt: project.created_at ?? null };
  }
  return status;
}
