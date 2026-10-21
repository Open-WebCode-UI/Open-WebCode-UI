import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import AdmZip from 'adm-zip';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { defineRoutes, fail, validate, z } from '../http.js';
import { getSettings } from '../settings.js';
import { audit } from '../audit.js';
import { resolveInJail, resolveForWrite, relFrom, isSecretPath, isGitPath, JailError } from '../workspace/jail.js';
import { safeGit } from '../workspace/git.js';
import { recordCheckpointMarks, rollBackMessages, copyCheckpointMarks } from '../sessions.js';
import { createCheckpoint, listCheckpoints, restoreCheckpoint, diffCheckpoint, isTurnActive } from '../workspace/checkpoints.js';
import { assertSafeUrl } from '../net-guard.js';
import { terminals } from '../terminal/manager.js';
import { kernels } from '../terminal/kernel.js';
import { scopeOf, touchesProtected } from '../courses/policy.js';
import { searchProject, MAX_QUERY } from '../workspace/search.js';

const SKIP = new Set(['node_modules', '.git']);
const NAME = /^[\w][\w .-]{0,63}$/;

export function getProject(req) {
  const p = getDb().prepare('SELECT * FROM projects WHERE id=? AND user_id=?').get(req.params.id ?? req.body?.projectId, req.user.id);
  if (!p) fail(404, 'project_not_found'); // object-level check: only own projects
  return p;
}
const guarded = (resolve) => (p, rel) => { try { return resolve(p.dir, rel); } catch (e) { if (e instanceof JailError) fail(400, 'invalid_path', { message: e.message }); throw e; } };
const jail = guarded(resolveInJail);
const jailWrite = guarded(resolveForWrite);
// Modifying operations: .git is off limits, and so is anything an exercise's rules protect (a folder holding a protected file included).
const jailW = (p, rel) => {
  const abs = jailWrite(p, rel);
  const globs = scopeOf(p.id)?.policy.protectedFiles;
  if (globs?.length) { const r = relFrom(p.dir, abs); if (touchesProtected(r, globs, abs)) fail(403, 'protected_file', { path: r }); }
  return abs;
};

function tree(dir, root, depth = 0) {
  if (depth > 12) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !SKIP.has(e.name) && !e.isSymbolicLink())
    .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name))
    .map((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? { name: e.name, path: relFrom(root, p), type: 'dir', children: tree(p, root, depth + 1) } : { name: e.name, path: relFrom(root, p), type: 'file' };
    });
}

// Validates every entry (names, counts, declared sizes) BEFORE inflating anything, so a bomb is rejected without allocating.
// adm-zip never inflates an entry past its declared size, so the declared sizes are a real bound. A single entry is also capped,
// because each one is inflated into memory in one piece. Any `.git` entry is dropped: a repository's config names programs git runs.
export function extractZipSafely(buf, dest, { maxBytes = 200 * 1024 * 1024, maxFiles = 20000, maxEntryBytes = Math.min(maxBytes, 256 * 1024 * 1024) } = {}) {
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  if (entries.length > maxFiles) fail(400, 'zip_too_many_files');
  const realDest = fs.realpathSync(dest);
  const plan = [];
  let total = 0;
  for (const e of entries) {
    const target = path.resolve(realDest, e.entryName);
    if (e.entryName.includes('\0') || path.isAbsolute(e.entryName) || (target !== realDest && !target.startsWith(realDest + path.sep))) fail(400, 'zip_slip');
    if (isGitPath(e.entryName)) continue;
    if (((e.attr >>> 16) & 0o170000) === 0o120000) continue; // never materialize symlinks
    if (!e.isDirectory) {
      const size = e.header.size;
      if (!Number.isSafeInteger(size) || size < 0 || size > maxEntryBytes) fail(400, 'zip_too_large');
      total += size;
      if (total > maxBytes) fail(400, 'zip_too_large'); // zip-bomb guard (declared sizes)
    }
    plan.push({ e, target });
  }
  for (const { e, target } of plan) {
    if (e.isDirectory) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const data = e.getData();
    if (data.length > e.header.size) fail(400, 'zip_size_mismatch');
    fs.writeFileSync(target, data);
  }
}

export function projectsRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/api');

  route.get('/projects', 'project.read', (req, res) => {
    res.json(getDb().prepare('SELECT id,name,created_at createdAt FROM projects WHERE user_id=? ORDER BY name').all(req.user.id));
  });

  const createDir = (userId, name) => {
    if (!NAME.test(name)) fail(400, 'invalid_name');
    const dir = path.join(config.dataDir, 'workspaces', String(userId), name);
    if (fs.existsSync(dir)) fail(409, 'project_exists');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const insert = (userId, name, dir) => Number(getDb().prepare('INSERT INTO projects (user_id,name,dir) VALUES (?,?,?)').run(userId, name, dir).lastInsertRowid);

  route.post('/projects', 'project.write', (req, res) => {
    const { name } = validate(z.object({ name: z.string().min(1).max(64) }), req.body);
    const dir = createDir(req.user.id, name);
    const id = insert(req.user.id, name, dir);
    audit(req.user.id, 'project.create', name);
    res.status(201).json({ id, name });
  });

  // Import: zip upload (base64 in JSON to avoid a multipart dependency surface) or clone from a Git URL.
  route.post('/projects/import', 'project.write', (req, res, next) => express.json({ limit: `${Math.ceil(getSettings('general').maxUploadMb * 4 / 3) + 1}mb` })(req, res, next), async (req, res) => {
    const b = validate(z.object({ name: z.string().min(1).max(64), zipBase64: z.string().optional(), gitUrl: z.string().max(1000).optional(), token: z.string().max(500).optional() }), req.body);
    const maxMb = getSettings('general').maxUploadMb;
    const dir = createDir(req.user.id, b.name);
    try {
      if (b.zipBase64) {
        const buf = Buffer.from(b.zipBase64, 'base64');
        if (buf.length > maxMb * 1024 * 1024) fail(413, 'upload_too_large');
        extractZipSafely(buf, dir, { maxBytes: Math.max(200, maxMb * 4) * 1024 * 1024 }); // unpacked cap scales with the admin's upload limit
      } else if (b.gitUrl) {
        await assertSafeUrl(b.gitUrl);
        const git = safeGit(null, { token: b.token });
        const args = ['clone', '--depth', '50', '--no-recurse-submodules', b.gitUrl, dir];
        await git.raw(args).catch(() => fail(400, 'clone_failed'));
      } else fail(400, 'source_required');
    } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
    const id = insert(req.user.id, b.name, dir);
    audit(req.user.id, 'project.import', b.name, { source: b.gitUrl ? 'git' : 'zip' });
    res.status(201).json({ id, name: b.name });
  });

  route.delete('/projects/:id', 'project.delete', (req, res) => {
    const p = getProject(req);
    if (isTurnActive(p.id)) fail(409, 'agent_running');
    terminals.killForProject(p.id); kernels.killForProject(p.id);
    getDb().prepare('DELETE FROM projects WHERE id=?').run(p.id);
    fs.rmSync(p.dir, { recursive: true, force: true });
    fs.rmSync(path.join(config.dataDir, 'checkpoints', `${p.id}.git`), { recursive: true, force: true });
    audit(req.user.id, 'project.delete', p.name);
    res.json({ ok: true });
  });

  // ---- files
  route.get('/projects/:id/tree', 'files.read', (req, res) => res.json(tree(fs.realpathSync(getProject(req).dir), getProject(req).dir)));
  route.get('/projects/:id/file', 'files.read', (req, res) => {
    const p = getProject(req), abs = jail(p, String(req.query.path || ''));
    let st; try { st = fs.statSync(abs); } catch { fail(404, 'not_found'); }
    if (!st.isFile()) fail(400, 'not_a_file');
    if (st.size > 5_000_000) fail(413, 'too_large');
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) fail(415, 'binary_file');
    res.json({ path: relFrom(p.dir, abs), content: buf.toString('utf8') });
  });
  // Find in files. Globs in include / exclude are comma separated and match a file name or a path suffix (see globToRegex).
  route.get('/projects/:id/search', 'files.read', async (req, res) => {
    const p = getProject(req), q = validate(z.object({
      q: z.string().min(1).max(MAX_QUERY), regex: z.enum(['0', '1']).optional(), case: z.enum(['0', '1']).optional(), word: z.enum(['0', '1']).optional(),
      include: z.string().max(300).optional(), exclude: z.string().max(300).optional(),
    }), req.query);
    const globs = (v) => (v || '').split(',').map((g) => g.trim()).filter(Boolean).slice(0, 20);
    const r = await searchProject({ root: p.dir, dir: fs.realpathSync(p.dir), query: q.q, regex: q.regex === '1', caseSensitive: q.case === '1', wholeWord: q.word === '1', include: globs(q.include), exclude: globs(q.exclude), skipDirs: SKIP });
    if (r.timedOut) fail(408, 'search_timeout');
    if (r.error === 'invalid_pattern') fail(400, 'invalid_pattern');
    if (r.error) fail(500, 'search_failed');
    res.json(r);
  });
  route.put('/projects/:id/file', 'files.write', express.json({ limit: '10mb' }), (req, res) => {
    const p = getProject(req), b = validate(z.object({ path: z.string().min(1).max(500), content: z.string() }), req.body);
    if (isTurnActive(p.id)) fail(409, 'agent_running');
    const abs = jailW(p, b.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, b.content);
    res.json({ ok: true });
  });
  route.post('/projects/:id/mkdir', 'files.write', (req, res) => {
    const p = getProject(req), { path: rel } = validate(z.object({ path: z.string().min(1).max(500) }), req.body);
    fs.mkdirSync(jailW(p, rel), { recursive: true });
    res.json({ ok: true });
  });
  // Rename or move (the same operation). Never silently replaces an existing file, and refuses to move a folder into itself.
  route.post('/projects/:id/rename', 'files.write', (req, res) => {
    const p = getProject(req), b = validate(z.object({ from: z.string().min(1).max(500), to: z.string().min(1).max(500), overwrite: z.boolean().default(false) }), req.body);
    if (isTurnActive(p.id)) fail(409, 'agent_running');
    const from = jailW(p, b.from), to = jailW(p, b.to), root = fs.realpathSync(p.dir);
    if (from === root) fail(400, 'cannot_move_root');
    let st; try { st = fs.lstatSync(from); } catch { fail(404, 'not_found'); }
    if (from === to) return res.json({ ok: true, unchanged: true });
    if (st.isDirectory() && (to + path.sep).startsWith(from + path.sep)) fail(400, 'cannot_move_into_itself');
    if (fs.existsSync(to)) {
      if (!b.overwrite) fail(409, 'exists');
      if (fs.statSync(to).isDirectory() || st.isDirectory()) fail(409, 'exists_directory'); // only file-over-file replacement is allowed
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    res.json({ ok: true });
  });
  route.delete('/projects/:id/file', 'files.write', (req, res) => {
    const p = getProject(req), abs = jailW(p, String(req.query.path || ''));
    if (abs === fs.realpathSync(p.dir)) fail(400, 'cannot_delete_root');
    if (isTurnActive(p.id)) fail(409, 'agent_running');
    fs.rmSync(abs, { recursive: true, force: true });
    res.json({ ok: true });
  });

  // Upload one file as the raw request body (binary safe, no base64 inflation). Existing files are only replaced with ?overwrite=1.
  const rawBody = (req, res, next) => express.raw({ type: () => true, limit: `${getSettings('general').maxUploadMb}mb` })(req, res, next);
  route.put('/projects/:id/upload', 'files.write', rawBody, (req, res) => {
    const p = getProject(req);
    if (isTurnActive(p.id)) fail(409, 'agent_running');
    const abs = jailW(p, String(req.query.path || ''));
    if (abs === fs.realpathSync(p.dir)) fail(400, 'invalid_path');
    if (!Buffer.isBuffer(req.body)) fail(400, 'file_required');
    if (fs.existsSync(abs)) { if (fs.statSync(abs).isDirectory()) fail(409, 'exists_directory'); if (req.query.overwrite !== '1') fail(409, 'exists'); }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, req.body);
    audit(req.user.id, 'file.upload', p.name, { path: relFrom(p.dir, abs), bytes: req.body.length });
    res.status(201).json({ ok: true, path: relFrom(p.dir, abs), bytes: req.body.length });
  });

  // ---- download
  const sendZip = (res, dir, name, { ignore = [] } = {}) => {
    res.attachment(`${name}.zip`);
    const zip = new ZipArchive({ zlib: { level: 6 } });
    zip.on('error', () => res.destroy());
    zip.pipe(res);
    zip.glob('**/*', { cwd: dir, dot: true, ignore, follow: false });
    zip.finalize();
  };
  // Whole project, or just a folder with ?path=. Folders and the project are zipped; node_modules is left out.
  route.get('/projects/:id/download', 'download.code', (req, res) => {
    const p = getProject(req), rel = req.query.path ? String(req.query.path) : '';
    const dir = rel ? jail(p, rel) : p.dir;
    let st; try { st = fs.statSync(dir); } catch { fail(404, 'not_found'); }
    if (!st.isDirectory()) fail(400, 'not_a_directory');
    audit(req.user.id, 'project.download', p.name, rel ? { path: rel } : {});
    sendZip(res, dir, rel ? path.basename(dir) : p.name, { ignore: ['node_modules/**'] });
  });
  // A single file, always as an attachment of an opaque type: project files are untrusted and must never be rendered on our origin.
  route.get('/projects/:id/download-file', 'files.read', (req, res) => {
    const p = getProject(req), abs = jail(p, String(req.query.path || ''));
    let st; try { st = fs.statSync(abs); } catch { fail(404, 'not_found'); }
    if (!st.isFile()) fail(400, 'not_a_file');
    res.attachment(path.basename(abs)); // sets a type from the file extension, so override it afterwards
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
  });

  // ---- git
  const gitOf = (p) => safeGit(p.dir);
  route.get('/projects/:id/git/status', 'git.commit', async (req, res) => {
    const p = getProject(req);
    if (!fs.existsSync(path.join(p.dir, '.git'))) return res.json({ initialized: false });
    const s = await gitOf(p).status();
    res.json({ initialized: true, branch: s.current, files: s.files.map((f) => ({ path: f.path, status: f.working_dir + f.index })), ahead: s.ahead });
  });
  route.post('/projects/:id/git/commit', 'git.commit', async (req, res) => {
    const p = getProject(req), b = validate(z.object({ message: z.string().min(1).max(500) }), req.body);
    const git = gitOf(p);
    if (!fs.existsSync(path.join(p.dir, '.git'))) await git.init();
    const name = req.user.display_name || req.user.username || 'User', email = req.user.email || 'user@localhost';
    await git.addConfig('user.name', name, false, 'local'); await git.addConfig('user.email', email, false, 'local');
    await git.add('-A');
    const out = await git.commit(b.message).catch((e) => fail(400, 'commit_failed', { message: String(e.message).slice(0, 200) }));
    audit(req.user.id, 'git.commit', p.name, { commit: out.commit });
    res.json({ commit: out.commit, summary: out.summary });
  });
  route.post('/projects/:id/git/push', 'git.push', async (req, res) => {
    const p = getProject(req), b = validate(z.object({ remoteUrl: z.string().max(1000), branch: z.string().regex(/^[\w./-]{1,100}$/).default('main'), token: z.string().max(500).optional() }), req.body);
    await assertSafeUrl(b.remoteUrl);
    // Token is supplied per-request via an HTTP header and never persisted or written to .git/config.
    const git = safeGit(p.dir, { token: b.token });
    const out = await git.raw(['push', b.remoteUrl, `HEAD:refs/heads/${b.branch}`]).catch((e) => fail(400, 'push_failed', { message: String(e.message).replace(b.token || '\0', '***').slice(0, 300) }));
    audit(req.user.id, 'git.push', p.name, { remote: b.remoteUrl, branch: b.branch });
    res.json({ ok: true, output: out.slice(0, 500) });
  });

  // ---- checkpoints
  route.get('/projects/:id/checkpoints', 'checkpoint.read', async (req, res) => {
    const p = getProject(req);
    res.json(await listCheckpoints(p.id, p.dir));
  });
  route.post('/projects/:id/checkpoints', 'checkpoint.write', async (req, res) => {
    const p = getProject(req), { label } = validate(z.object({ label: z.string().min(1).max(120).default('Manual checkpoint') }), req.body);
    if (isTurnActive(p.id)) fail(409, 'agent_running');
    const cp = await createCheckpoint(p.id, p.dir, { label, author: 'user' });
    recordCheckpointMarks(p.id, cp.id);
    audit(req.user.id, 'checkpoint.create', p.name, { label });
    res.status(201).json(cp);
  });
  route.get('/projects/:id/checkpoints/:cp/diff', 'checkpoint.read', async (req, res) => {
    const p = getProject(req);
    const { files, show } = await diffCheckpoint(p.id, p.dir, req.params.cp).catch(() => fail(400, 'invalid_checkpoint'));
    const file = req.query.file ? String(req.query.file) : null;
    if (file) { jail(p, file); return res.json({ path: file, checkpointContent: await show(file) }); }
    res.json({ files });
  });
  route.post('/projects/:id/checkpoints/:cp/restore', 'checkpoint.write', async (req, res) => {
    const p = getProject(req);
    if (isTurnActive(p.id)) fail(409, 'agent_running');
    const out = await restoreCheckpoint(p.id, p.dir, req.params.cp).catch((e) => fail(400, 'restore_failed', { message: e.message }));
    // Sessions go back with the files. The "Before restore" checkpoint remembers where they stood, so rolling forward restores them too.
    recordCheckpointMarks(p.id, out.before.id);
    const conversations = rollBackMessages(req.params.cp);
    copyCheckpointMarks(req.params.cp, out.after.id);
    audit(req.user.id, 'checkpoint.restore', p.name, { to: req.params.cp });
    res.json({ ...out, conversations });
  });

  return r;
}
