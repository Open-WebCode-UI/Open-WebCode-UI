import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { globToRegex, isGitPath } from '../workspace/jail.js';

// The agent rules for one exercise. They only ever subtract from what the learner's own role allows: the effective permissions
// are the learner's permissions minus whatever the policy denies, so an instructor can never grant anything.
export const TOOL_DENY = ['subagents', 'skills', 'web_search', 'mcp', 'memory'];
export const POLICY_VERSION = 1;

const glob = z.string().trim().min(1).max(120).refine((g) => !g.startsWith('/') && !g.includes('\\') && !g.includes('\0') && !g.split('/').includes('..') && !isGitPath(g), 'invalid pattern');
export const policySchema = z.object({
  version: z.literal(POLICY_VERSION).default(POLICY_VERSION),
  preset: z.enum(['plan_only', 'guided', 'full', 'custom']).default('guided'),
  mode: z.enum(['plan', 'act']), // the most the learner may do: plan = read-only Plan mode
  requirePlan: z.boolean(), // Act turns need a plan the agent proposed in this session
  shell: z.boolean(), // shell commands and the terminal
  toolDeny: z.array(z.enum(TOOL_DENY)).max(TOOL_DENY.length),
  protectedFiles: z.array(glob).max(20), // cannot be changed, moved or deleted by the agent or the learner
  git: z.boolean(), // commit, push and download
  checkpoints: z.boolean(),
  modelId: z.number().int().nullable(),
  maxSteps: z.number().int().min(1).max(100).nullable(), // agent steps per turn
  maxMessages: z.number().int().min(1).max(500).nullable(), // learner messages across the workspace's sessions
  maxCost: z.number().min(0.01).max(10_000).nullable(), // spend on the workspace's sessions, in the usage currency
  timeLimitMin: z.number().int().min(1).max(10_080).nullable(), // after which the workspace is frozen
}).superRefine((p, ctx) => {
  // A shell can edit any file, so protected files and a shell cannot be combined.
  if (p.protectedFiles.length && p.shell) ctx.addIssue({ code: 'custom', path: ['protectedFiles'], message: 'protected files need the shell to be off' });
  if (p.requirePlan && p.mode === 'plan') ctx.addIssue({ code: 'custom', path: ['requirePlan'], message: 'a plan is only needed before acting' });
});

const base = { version: POLICY_VERSION, protectedFiles: [], checkpoints: true, modelId: null, maxSteps: null, maxMessages: null, maxCost: null, timeLimitMin: null };
export const PRESETS = {
  plan_only: { ...base, preset: 'plan_only', mode: 'plan', requirePlan: false, shell: false, toolDeny: [...TOOL_DENY], git: false },
  guided: { ...base, preset: 'guided', mode: 'act', requirePlan: true, shell: false, toolDeny: [...TOOL_DENY], git: false },
  full: { ...base, preset: 'full', mode: 'act', requirePlan: false, shell: true, toolDeny: [], git: false },
};
export const DEFAULT_PRESET = 'guided';

// Missing or unreadable policies fall back to Guided, the conservative default.
export function normalizePolicy(raw) {
  const r = policySchema.safeParse(raw ?? undefined);
  return r.success ? r.data : structuredClone(PRESETS[DEFAULT_PRESET]);
}

// Permissions the policy takes away. `locked` (after submit, or once the time limit has passed) freezes the workspace.
const FROZEN = ['files.write', 'agent.plan', 'agent.act', 'agent.shell.run', 'terminal.use', 'git.commit', 'git.push', 'checkpoint.write', 'mcp.use', 'memory.use', 'websearch.use'];
export function deniedPermissions(policy, { locked = false } = {}) {
  const d = new Set(locked ? FROZEN : []);
  if (policy.mode === 'plan') d.add('agent.act');
  if (!policy.shell) { d.add('agent.shell.run'); d.add('terminal.use'); }
  if (!policy.git) { d.add('git.commit'); d.add('git.push'); d.add('download.code'); }
  if (!policy.checkpoints) { d.add('checkpoint.read'); d.add('checkpoint.write'); }
  if (policy.toolDeny.includes('mcp')) d.add('mcp.use');
  if (policy.toolDeny.includes('memory')) { d.add('memory.use'); d.add('chat.coding.memory'); d.add('chat.general.memory'); }
  if (policy.toolDeny.includes('web_search')) { d.add('websearch.use'); d.add('chat.coding.websearch'); d.add('chat.general.websearch'); }
  return d;
}
export const effectivePermissions = (userPerms, scope) => new Set([...userPerms].filter((p) => !scope.denied.has(p)));

// Tool names the agent is never offered (checked again when a tool runs).
export function deniedTools(policy) {
  const out = new Set();
  if (policy.toolDeny.includes('subagents')) out.add('spawn_agent');
  if (policy.toolDeny.includes('skills')) out.add('use_skill');
  if (policy.toolDeny.includes('web_search')) out.add('web_search');
  if (policy.toolDeny.includes('memory')) { out.add('save_memory'); out.add('read_memory'); }
  return out;
}

// ---------- Scope of a workspace: the frozen policy of the attempt it belongs to, or null for an ordinary project
const now = () => Math.floor(Date.now() / 1000);
export function scopeOf(projectId) {
  if (projectId == null) return null;
  const row = getDb().prepare(`SELECT ew.policy_json, ew.attempt_id, ew.question_id, att.status, att.started_at
    FROM exercise_workspaces ew JOIN attempts att ON att.id=ew.attempt_id WHERE ew.project_id=?`).get(projectId);
  if (!row) return null;
  const policy = normalizePolicy(row.policy_json ? JSON.parse(row.policy_json) : null);
  const deadline = policy.timeLimitMin ? row.started_at + policy.timeLimitMin * 60 : null;
  const submitted = row.status !== 'in_progress';
  const expired = !submitted && deadline != null && now() > deadline;
  const locked = submitted || expired;
  return { policy, locked, submitted, expired, deadline, attemptId: row.attempt_id, questionId: row.question_id, denied: deniedPermissions(policy, { locked }), toolDeny: deniedTools(policy) };
}

// ---------- Protected files
// A path is protected when a pattern matches it or any folder above it (so protecting "tests" protects everything inside).
export function isProtected(rel, globs) {
  if (!globs?.length) return false;
  const parts = String(rel).split('/').filter(Boolean);
  return globs.some((g) => { const re = globToRegex(g.replace(/\/+$/, '')); return parts.some((_, i) => re.test(parts.slice(0, i + 1).join('/'))); });
}
// For delete and move: a folder is protected too when anything inside it is (checked on disk, bounded).
export function touchesProtected(rel, globs, absDir) {
  if (isProtected(rel, globs)) return true;
  if (!globs?.length || !absDir) return false;
  let seen = 0;
  const walk = (dir, relDir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++seen > 5000) return true; // too big to vouch for: refuse
      const r = relDir ? `${relDir}/${e.name}` : e.name;
      if (isProtected(r, globs)) return true;
      if (e.isDirectory() && !e.isSymbolicLink() && walk(path.join(dir, e.name), r)) return true;
    }
    return false;
  };
  try { return fs.statSync(absDir).isDirectory() ? walk(absDir, rel) : false; } catch { return false; }
}

// ---------- Limits on a workspace's sessions
export function usageOf(projectId) {
  const db = getDb();
  const messages = db.prepare(`SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.project_id=? AND c.kind='agent' AND m.role='user' AND m.archived=0`).get(projectId).n;
  const cost = db.prepare(`SELECT COALESCE(SUM(u.cost),0) c FROM usage u JOIN conversations c ON c.id=u.conversation_id WHERE c.project_id=? AND c.kind='agent'`).get(projectId).c;
  return { messages, cost };
}

// Plain-language summary of a policy, shown to the learner before and during the exercise.
export function describePolicy(p) {
  const out = [];
  out.push(p.mode === 'plan' ? 'You can plan with the agent, but not let it change files.' : p.requirePlan ? 'The agent must propose a plan, and you approve it, before it can change files.' : 'The agent can change files.');
  out.push(p.shell ? 'Shell commands are allowed.' : 'Shell commands and the terminal are off.');
  const names = { subagents: 'subagents', skills: 'skills', web_search: 'web search', mcp: 'MCP tools', memory: 'memory' };
  if (p.toolDeny.length) out.push(`Turned off: ${p.toolDeny.map((t) => names[t]).join(', ')}.`);
  if (p.protectedFiles.length) out.push(`These cannot be changed: ${p.protectedFiles.join(', ')}.`);
  if (!p.git) out.push('Git and downloads are off.');
  if (!p.checkpoints) out.push('Checkpoints are off.');
  if (p.maxSteps) out.push(`Up to ${p.maxSteps} agent steps per message.`);
  if (p.maxMessages) out.push(`Up to ${p.maxMessages} messages to the agent.`);
  if (p.maxCost) out.push('There is a spending limit for the agent.');
  if (p.timeLimitMin) out.push(`You have ${p.timeLimitMin} minutes once you start; then the workspace is frozen (you can still submit).`);
  return out;
}
