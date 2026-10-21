import { describe, it, expect } from 'vitest';
import { normalizeConclusion } from '../src/agent/conclusion.js';
import { TOOL_DEFS, executeTool } from '../src/agent/tools.js';
import { DEFAULT_PLAN_PROMPT, DEFAULT_ACT_PROMPT, DEFAULT_SUBAGENT_PROMPT } from '../src/agent/prompts.js';
import { buildTimeline } from '../src/sessions.js';

describe('conclusion payload', () => {
  it('trims text, caps lists, and lengths, and falls back to safe defaults', () => {
    const c = normalizeConclusion({ summary: `  ${'x'.repeat(9000)}  `, status: 'weird', changes: [' a.js ', '', 7, ...Array.from({ length: 80 }, (_, i) => `f${i}`)], verification: ' ok ', next_steps: ['one', 'two', 'three', 'four', 'five', '  '], needs: 'ignored when complete' });
    expect(c.summary).toHaveLength(6000); expect(c.status).toBe('complete'); expect(c.changes).toHaveLength(60); expect(c.changes.slice(0, 2)).toEqual(['a.js', '7']);
    expect(c.verification).toBe('ok'); expect(c.next_steps).toEqual(['one', 'two', 'three', 'four']); expect(c.needs).toBe('');
    expect(normalizeConclusion()).toEqual({ summary: '', status: 'complete', changes: [], verification: '', next_steps: [], needs: '' });
    expect(normalizeConclusion({ summary: 's', next_steps: ['y'.repeat(500)] }).next_steps[0]).toHaveLength(200);
  });
  it('"needs" is kept only for unfinished work', () => {
    expect(normalizeConclusion({ summary: 's', status: 'blocked', needs: ' Which database? ' }).needs).toBe('Which database?');
    expect(normalizeConclusion({ summary: 's', status: 'partial', needs: 'A decision' }).needs).toBe('A decision'); expect(normalizeConclusion({ summary: 's', status: 'complete', needs: 'x' }).needs).toBe('');
  });
  it('non-array lists and odd types never break it', () => { expect(normalizeConclusion({ summary: 5, changes: 'a.js', next_steps: { a: 1 }, verification: null })).toMatchObject({ summary: '5', changes: [], next_steps: [], verification: '' }); });
  it('the tool hands the cleaned payload to the UI and the stored timeline shows the same thing', async () => {
    let got; await executeTool('conclude', { summary: ' Fixed it ', status: 'blocked', needs: 'The staging URL', changes: ['a.js'], next_steps: ['Retry'] }, { agentMode: 'act', permissions: new Set(['agent.act']), onConclude: (c) => { got = c; } });
    expect(got).toEqual({ summary: 'Fixed it', status: 'blocked', changes: ['a.js'], verification: '', next_steps: ['Retry'], needs: 'The staging URL' });
    const rows = [{ role: 'assistant', content: JSON.stringify({ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'conclude', args: { summary: ' Fixed it ', status: 'blocked', needs: 'The staging URL', changes: ['a.js'], next_steps: ['Retry'] } }] }), archived: 0, kind: null }];
    expect(buildTimeline(rows)[0]).toEqual({ kind: 'conclusion', c: got });
  });
});

describe('telling the agent how to conclude', () => {
  const schema = TOOL_DEFS.conclude;
  it('the tool definition explains every field, so the model sees the guidance even without the prompt', () => {
    expect(Object.keys(schema.parameters.properties)).toEqual(['summary', 'status', 'changes', 'verification', 'next_steps', 'needs']); expect(schema.parameters.required).toEqual(['summary', 'status']);
    expect(schema.description).toMatch(/exactly once, as your very last action/); expect(schema.description).toMatch(/person who has not followed every step/);
    const p = schema.parameters.properties;
    expect(p.summary.description).toMatch(/lead|led by/i); expect(p.summary.description).toMatch(/not which tools you ran/); expect(p.summary.description).toMatch(/backticks/);
    expect(p.status.description).toMatch(/only when everything asked for is done and checked/); expect(p.verification.description).toMatch(/Not run/); expect(p.next_steps.description).toMatch(/click to send back/); expect(p.needs.description).toMatch(/partial|blocked/);
  });
  it.each([['Plan', DEFAULT_PLAN_PROMPT], ['Act', DEFAULT_ACT_PROMPT]])('the %s prompt has a "Writing your conclusion" section covering each field and honesty', (_, p) => {
    expect(p).toContain('# Writing your conclusion');
    for (const f of ['summary', 'status', 'changes', 'verification', 'next_steps', 'needs']) expect(p, f).toContain(`**${f}**`);
    expect(p).toMatch(/once, as your very last action, and write nothing after it/); expect(p).toMatch(/never mark work "complete" that you did not finish or check/); expect(p).toMatch(/click to send back to you/); expect(p).toMatch(/not which tools you ran/);
  });
  it('Plan mode explains what "changes" means for a read-only session; Act mode for edits', () => { expect(DEFAULT_PLAN_PROMPT).toMatch(/key files you studied \(Plan mode\)/); expect(DEFAULT_ACT_PROMPT).toMatch(/created, edited, or deleted \(Act mode\)/); });
  it('Plan mode still tells the agent when to use propose_plan or switch_mode instead of conclude', () => { expect(DEFAULT_PLAN_PROMPT).toMatch(/propose_plan[\s\S]*switch_mode[\s\S]*conclude/); expect(DEFAULT_PLAN_PROMPT).toMatch(/Do not call both propose_plan and switch_mode/); });
  it('subagents know their conclusion is the report their parent receives', () => {
    expect(DEFAULT_SUBAGENT_PROMPT).toMatch(/Your conclude summary IS your report/); for (const f of ['changes', 'verification', 'needs']) expect(DEFAULT_SUBAGENT_PROMPT).toContain(`**${f}**`); expect(DEFAULT_SUBAGENT_PROMPT).toMatch(/never claim a check you did not run/);
  });
});
