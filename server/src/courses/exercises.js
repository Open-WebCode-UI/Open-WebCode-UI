import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getKnex } from '../db/index.js';
import { trx, insertId } from '../db/dialect.js';
import { config } from '../config.js';
import { TOOL_DEFS } from '../agent/tools.js';
import { resolveInJail, resolveForWrite, isGitPath, JailError } from '../workspace/jail.js';
import { loadMessages } from '../sessions.js';
import { policySchema, normalizePolicy, PRESETS, DEFAULT_PRESET } from './policy.js';

// ---------- The exercise spec an instructor writes (question.code_spec_json)
// Checks are declarative: they read files and the agent transcript, and never run anything. An instructor's text can therefore
// not reach the host, whatever it says.
const relPath = z.string().min(1).max(200).refine((p) => !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') && !p.split('/').some((s) => s === '..' || s === '') && !isGitPath(p), 'invalid path');
const label = z.string().trim().min(1).max(100);
const pts = z.number().int().min(1).max(100);
const text = z.string().min(1).max(500);
export const CHECK_TYPES = ['file_exists', 'file_missing', 'file_contains', 'file_not_contains', 'file_changed', 'used_tool', 'prompt_mentions'];
export const TOOLS = Object.keys(TOOL_DEFS);
const check = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file_exists'), label, points: pts, path: relPath }),
  z.object({ type: z.literal('file_missing'), label, points: pts, path: relPath }),
  z.object({ type: z.literal('file_contains'), label, points: pts, path: relPath, text, ignoreCase: z.boolean().default(false) }),
  z.object({ type: z.literal('file_not_contains'), label, points: pts, path: relPath, text, ignoreCase: z.boolean().default(false) }),
  z.object({ type: z.literal('file_changed'), label, points: pts, path: relPath }),
  z.object({ type: z.literal('used_tool'), label, points: pts, tool: z.enum(TOOLS), min: z.number().int().min(1).max(100).default(1) }),
  z.object({ type: z.literal('prompt_mentions'), label, points: pts, text, }),
]);
export const exerciseSpec = z.object({
  brief: z.string().trim().min(1).max(4000),
  starterFiles: z.array(z.object({ path: relPath, content: z.string().max(100_000) })).max(50).default([])
    .refine((a) => a.reduce((n, f) => n + f.content.length, 0) <= 500_000, 'starter files too large').refine((a) => new Set(a.map((f) => f.path)).size === a.length, 'duplicate path'),
  checks: z.array(check).max(20).default([]),
  rubric: z.array(z.object({ label, points: pts })).max(10).default([]), // marked by the instructor
  policy: policySchema.default(() => structuredClone(PRESETS[DEFAULT_PRESET])), // agent rules; only ever narrow the learner's own permissions
}).refine((s) => s.checks.length + s.rubric.length > 0, 'needs at least one check or rubric item');
export const specPoints = (s) => s.checks.reduce((n, c) => n + c.points, 0) + s.rubric.reduce((n, r) => n + r.points, 0);

// ---------- Workspaces
const workspaceDir = (userId, name) => path.join(config.dataDir, 'workspaces', String(userId), name);

// One workspace per exercise per attempt: an ordinary project owned by the learner, seeded with the starter files.
export async function createWorkspace(userId, courseId, attemptId, q) {
  const spec = JSON.parse(q.code_spec_json);
  const name = `course-${courseId}-a${attemptId}-q${q.id}`;
  const dir = workspaceDir(userId, name);
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const f of spec.starterFiles || []) {
      const abs = resolveForWrite(dir, f.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content);
    }
    return await trx(getKnex(), async (t) => {
      const projectId = await insertId(t('projects'), { user_id: userId, name, dir });
      // The rules are copied here, so editing the exercise later cannot change an attempt in progress.
      await t('exercise_workspaces').insert({ attempt_id: attemptId, question_id: q.id, project_id: projectId, policy_json: JSON.stringify(normalizePolicy(spec.policy)) });
      return projectId;
    });
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
}
export const workspaceOf = (attemptId, qid) => getKnex()('exercise_workspaces').where({ attempt_id: attemptId, question_id: qid }).first();

// ---------- Transcript: what the learner asked and what the agent did, across the workspace's sessions
const clip = (v, n) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n)}…` : v);
export async function transcriptOf(projectId) {
  if (projectId == null) return [];
  const out = [];
  const convs = await getKnex()('conversations').where({ project_id: projectId, kind: 'agent' }).orderBy('id').select('id');
  for (const c of convs) for (const m of await loadMessages(c.id)) {
    if (m.role === 'user') out.push({ role: 'user', content: clip(String(m.display ?? m.content ?? ''), 3000) });
    else if (m.role === 'assistant') out.push({ role: 'assistant', content: clip(String(m.content ?? ''), 3000), tools: (m.toolCalls || []).map((t) => ({ name: t.name, args: clip(JSON.stringify(t.args ?? {}), 300) })) });
    if (out.length >= 2000) return out;
  }
  return out;
}

// ---------- Checks
const MAX_READ = 1024 * 1024;
export function runChecks(spec, { dir, transcript }) {
  const starter = new Map((spec.starterFiles || []).map((f) => [f.path, f.content]));
  const read = (rel) => { // file text, or { error }
    if (!dir) return { error: 'The workspace no longer exists' };
    try {
      const abs = resolveInJail(dir, rel);
      const st = fs.lstatSync(abs);
      if (!st.isFile()) return { error: 'File not found', missing: true };
      if (st.size > MAX_READ) return { error: 'File is too large to check' };
      return { text: fs.readFileSync(abs, 'utf8') };
    } catch (e) { return e instanceof JailError || e.code === 'ENOENT' ? { error: 'File not found', missing: true } : { error: 'File could not be read' }; }
  };
  const has = (hay, needle, ic) => (ic ? hay.toLowerCase().includes(needle.toLowerCase()) : hay.includes(needle));
  const calls = transcript.flatMap((m) => m.tools || []);
  return (spec.checks || []).map((c) => {
    let ok = false; let detail = '';
    if (c.type === 'file_exists') { const r = read(c.path); ok = !r.error; detail = r.error || ''; }
    else if (c.type === 'file_missing') { const r = read(c.path); ok = r.missing === true; detail = ok ? '' : r.error && !r.missing ? r.error : 'File exists'; }
    else if (c.type === 'file_contains') { const r = read(c.path); ok = !r.error && has(r.text, c.text, c.ignoreCase); detail = r.error || (ok ? '' : 'Text not found'); }
    else if (c.type === 'file_not_contains') { const r = read(c.path); ok = !r.error && !has(r.text, c.text, c.ignoreCase); detail = r.error || (ok ? '' : 'Text found'); }
    else if (c.type === 'file_changed') { const r = read(c.path); ok = !r.error && r.text !== starter.get(c.path); detail = r.error || (ok ? '' : 'File is unchanged'); }
    else if (c.type === 'used_tool') { ok = calls.filter((t) => t.name === c.tool).length >= c.min; detail = ok ? '' : 'Not used enough'; }
    else if (c.type === 'prompt_mentions') { ok = transcript.some((m) => m.role === 'user' && has(m.content, c.text, true)); detail = ok ? '' : 'Not mentioned'; }
    return { label: c.label, points: c.points, passed: ok, earned: ok ? c.points : 0, detail };
  });
}

// ---------- Snapshots (the evidence an instructor reviews)
const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv']);
const LIMITS = { files: 500, bytes: 5 * 1024 * 1024, file: MAX_READ };
export const snapshotRoot = () => path.join(config.dataDir, 'course-submissions');

export function snapshot(attemptId, qid, dir, transcript) {
  const rel = path.join('course-submissions', String(attemptId), String(qid));
  const base = path.join(config.dataDir, rel); const files = path.join(base, 'files');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(files, { recursive: true });
  let count = 0; let bytes = 0;
  const walk = (src, dst) => {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.isSymbolicLink()) continue; // symlinks are never followed
      const s = path.join(src, e.name); const d = path.join(dst, e.name);
      if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); walk(s, d); continue; }
      if (!e.isFile()) continue;
      const size = fs.statSync(s).size;
      if (size > LIMITS.file || count >= LIMITS.files || bytes + size > LIMITS.bytes) continue;
      fs.copyFileSync(s, d); count++; bytes += size;
    }
  };
  if (dir && fs.existsSync(dir)) walk(fs.realpathSync(dir), files);
  fs.writeFileSync(path.join(base, 'transcript.json'), JSON.stringify(transcript));
  return rel;
}
export function removeSnapshots(attemptIds) {
  for (const id of attemptIds) fs.rmSync(path.join(snapshotRoot(), String(id)), { recursive: true, force: true });
}
export function snapshotFiles(rel) {
  const root = path.join(config.dataDir, rel, 'files'); const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) out.push({ path: path.relative(root, p).split(path.sep).join('/'), size: fs.statSync(p).size }); } };
  if (fs.existsSync(root)) walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
export const snapshotFile = (rel, file) => fs.readFileSync(resolveInJail(path.join(config.dataDir, rel, 'files'), file), 'utf8');
export const snapshotTranscript = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(config.dataDir, rel, 'transcript.json'), 'utf8')); } catch { return []; } };
