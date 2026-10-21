import { describe, it, expect } from 'vitest';
import { policySchema, PRESETS, normalizePolicy, deniedPermissions, effectivePermissions, deniedTools, isProtected, describePolicy } from '../src/courses/policy.js';

const dev = new Set(['project.read', 'files.read', 'files.write', 'agent.plan', 'agent.act', 'agent.shell.run', 'terminal.use', 'git.commit', 'git.push', 'download.code', 'checkpoint.read', 'checkpoint.write', 'mcp.use', 'memory.use', 'websearch.use', 'provider.use']);
const scope = (p, o) => ({ denied: deniedPermissions(p, o) });

describe('presets', () => {
  it('every preset is a valid policy', () => { for (const p of Object.values(PRESETS)) expect(policySchema.safeParse(p).success, p.preset).toBe(true); });
  it('Guided plans first with no shell, git or extras', () => {
    const e = effectivePermissions(dev, scope(PRESETS.guided));
    expect(e.has('agent.act')).toBe(true);
    for (const p of ['agent.shell.run', 'terminal.use', 'git.push', 'git.commit', 'download.code', 'mcp.use', 'memory.use', 'websearch.use']) expect(e.has(p), p).toBe(false);
    expect(e.has('files.write')).toBe(true); expect(e.has('checkpoint.write')).toBe(true);
  });
  it('Plan only removes Act; Full keeps the shell but still no git or downloads', () => {
    expect(effectivePermissions(dev, scope(PRESETS.plan_only)).has('agent.act')).toBe(false);
    const f = effectivePermissions(dev, scope(PRESETS.full));
    expect(f.has('agent.shell.run') && f.has('mcp.use') && f.has('memory.use')).toBe(true);
    expect(f.has('git.push') || f.has('download.code')).toBe(false);
  });
});

describe('narrowing only', () => {
  it('never grants a permission the learner lacks', () => {
    const none = new Set(['project.read', 'agent.plan']);
    for (const p of Object.values(PRESETS)) expect([...effectivePermissions(none, scope(p))].every((x) => none.has(x))).toBe(true);
  });
  it('freezing (after submit or the time limit) removes everything that changes things but keeps reading', () => {
    const e = effectivePermissions(dev, scope({ ...PRESETS.full, git: true }, { locked: true }));
    for (const p of ['files.write', 'agent.plan', 'agent.act', 'agent.shell.run', 'terminal.use', 'git.commit', 'git.push', 'checkpoint.write']) expect(e.has(p), p).toBe(false);
    for (const p of ['project.read', 'files.read', 'checkpoint.read']) expect(e.has(p), p).toBe(true);
  });
  it('tool denials map to tools and permissions', () => {
    expect([...deniedTools({ toolDeny: ['subagents', 'skills', 'web_search', 'memory'] })].sort()).toEqual(['read_memory', 'save_memory', 'spawn_agent', 'use_skill', 'web_search']);
    expect(deniedPermissions({ ...PRESETS.full, toolDeny: ['mcp'] }).has('mcp.use')).toBe(true);
  });
});

describe('validation', () => {
  const ok = { ...PRESETS.guided };
  it('rejects protected files together with a shell, a plan requirement without Act, and unsafe patterns', () => {
    expect(policySchema.safeParse({ ...ok, shell: true, protectedFiles: ['tests'] }).success).toBe(false);
    expect(policySchema.safeParse({ ...ok, mode: 'plan', requirePlan: true }).success).toBe(false);
    for (const g of ['../x', '/etc/passwd', '.git/hooks', 'a\\b']) expect(policySchema.safeParse({ ...ok, protectedFiles: [g] }).success, g).toBe(false);
    expect(policySchema.safeParse({ ...ok, protectedFiles: ['tests', '*.test.js'] }).success).toBe(true);
    expect(policySchema.safeParse({ ...ok, maxSteps: 0 }).success).toBe(false);
  });
  it('falls back to Guided for missing or broken policies', () => {
    expect(normalizePolicy(undefined).preset).toBe('guided'); expect(normalizePolicy({ mode: 'nope' }).preset).toBe('guided');
    expect(normalizePolicy(PRESETS.full).shell).toBe(true);
  });
});

describe('protected files', () => {
  it('protects a pattern, everything under a protected folder, and matches at any depth', () => {
    const g = ['tests', '*.lock', 'src/answer.js'];
    expect(isProtected('tests/a.js', g)).toBe(true); expect(isProtected('tests/deep/b.js', g)).toBe(true); expect(isProtected('app/tests/c.js', g)).toBe(true);
    expect(isProtected('yarn.lock', g)).toBe(true); expect(isProtected('src/answer.js', g)).toBe(true);
    expect(isProtected('src/other.js', g)).toBe(false); expect(isProtected('testsuite.js', g)).toBe(false); expect(isProtected('x', [])).toBe(false);
  });
  it('describes the rules in plain words', () => {
    expect(describePolicy(PRESETS.guided).join(' ')).toMatch(/must propose a plan.*Shell commands and the terminal are off.*Git and downloads are off/);
    expect(describePolicy({ ...PRESETS.plan_only, protectedFiles: ['tests'], timeLimitMin: 30 }).join(' ')).toMatch(/tests.*30 minutes/);
  });
});
