import { WebSocketServer } from 'ws';
import { config } from '../config.js';
import { parseCookies, cookieName, loadSession } from '../auth/session.js';
import { userPermissions } from '../auth/rbac.js';
import { scopeOf, effectivePermissions } from '../courses/policy.js';

// The user's permissions for one project: narrowed by the rules of a course exercise workspace, if it is one.
const permsFor = async (userId, projectId) => { const base = userPermissions(userId), sc = await scopeOf(projectId); return sc ? effectivePermissions(base, sc) : base; };
import { getSettings } from '../settings.js';
import { audit } from '../audit.js';
import { terminals as defaultManager } from './manager.js';

export const shellEnabled = () => getSettings('general').execMode === 'workspace_shell';
const originOk = (req) => {
  const o = req.headers.origin; if (!o) return false; // browsers always send Origin on WebSocket handshakes
  try { const u = new URL(o); return u.origin === new URL(config.baseUrl).origin || u.host === req.headers.host; } catch { return false; }
};

// Terminal WebSocket: /api/terminal/ws?id=<session id>. The handshake is authenticated with the session cookie, must come from
// our own origin (cross-site WebSocket hijacking), and only the session's owner may attach. The agent's shell is view-only.
export function attachTerminalWs(server, { manager = defaultManager, sweepMs = 30_000 } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/api/terminal/ws') return;
    const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (!originOk(req)) return reject(403, 'Forbidden');
    const sess = await loadSession(parseCookies(req.headers.cookie)[cookieName()]);
    if (!sess || sess.stage !== 'full') return reject(401, 'Unauthorized');
    const term = manager.get(url.searchParams.get('id') || '');
    const perms = await permsFor(sess.user.id, term?.projectId).catch(() => null);
    if (!perms) return reject(500, 'Internal Server Error');
    const allowed = term && term.userId === sess.user.id && shellEnabled() && (term.kind === 'agent' ? perms.has('agent.shell.run') || perms.has('terminal.use') : perms.has('terminal.use'));
    if (!allowed) return reject(404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, { sess, term }));
  });

  wss.on('connection', (ws, _req, { sess, term }) => {
    const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
    send({ type: 'ready', kind: term.kind, cols: term.cols, rows: term.rows });
    // When the shell ends (it exited, was killed, or shell mode was switched off) close the socket too, so clients react at once.
    const detach = term.attach((m) => { send(m); if (m.type === 'exit') setTimeout(() => ws.close(1000, 'shell ended'), 30); });
    if (term.kind === 'user') audit(sess.user.id, 'terminal.attach', String(term.projectId));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (term.kind !== 'user') return; // the agent's terminal is read-only for viewers
      if (m.type === 'input' && typeof m.data === 'string' && m.data.length <= 65_536) term.write(m.data);
      else if (m.type === 'resize') term.resize(Number(m.cols), Number(m.rows));
    });
    // Re-validate regularly: revoked session, disabled user, lost permission, or shell mode switched off all end the connection.
    const timer = setInterval(async () => {
      const s = await loadSession(sess.id), perms = s && await permsFor(s.user.id, term.projectId).catch(() => null);
      if (s && !perms) return; // could not check this time (database error): keep the connection, try again at the next sweep
      const ok = s && s.stage === 'full' && shellEnabled() && (term.kind === 'agent' ? perms.has('agent.shell.run') || perms.has('terminal.use') : perms.has('terminal.use'));
      if (!ok) { send({ type: 'closed', reason: 'access_revoked' }); ws.close(4401, 'access revoked'); if (term.kind === 'user') manager.close(term.id); }
      else if (ws.readyState === 1) ws.ping();
    }, sweepMs); timer.unref();
    ws.on('close', () => { clearInterval(timer); detach(); });
  });
  return wss;
}
