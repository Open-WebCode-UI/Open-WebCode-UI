import { runAgentTurn } from './loop.js';
import { createCheckpoint } from '../workspace/checkpoints.js';
import { DEFAULT_SUBAGENT_PROMPT, PLAN_SAFETY_CLAUSE, ACT_SAFETY_CLAUSE, effortNote } from './prompts.js';

export const MAX_SUBAGENTS_PER_TURN = 8;   // total children one turn may start
export const MAX_PARALLEL = 3;             // children running at once (read-only ones)
const RESULT_CAP = 8000;
const EVENTS_FOR_UI = new Set(['text', 'thinking', 'tool_start', 'tool_result', 'checkpoint', 'file_changed', 'approval']);

class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async acquire() { if (this.n > 0) { this.n -= 1; return; } await new Promise((r) => this.q.push(r)); }
  release() { const next = this.q.shift(); if (next) next(); else this.n += 1; }
}

// Builds the `ctx.spawnSubagent` used by the spawn_agent tool. A child is a fresh conversation (it cannot see the parent's) that
// runs the same agent loop with a restricted tool set. It can never exceed the parent's authority:
//   - a Plan-mode parent can only start read-only children;
//   - an Act child needs an Act-mode parent AND the agent.act permission;
//   - children cannot spawn children, talk to the user, or change the mode; shell commands still need the user's approval.
export function createSubagentRuntime({ ctx, adapter, model, system, emit, signal, maxIterations, maxTokens, temperature, thinking, audit, permissions, onUsage, effort }) {
  const parallel = new Semaphore(MAX_PARALLEL), actLock = new Semaphore(1);
  let started = 0;
  return async function spawnSubagent({ task, mode, name }, callId) {
    if (!task.trim()) return 'Error: "task" is required.';
    if (started >= MAX_SUBAGENTS_PER_TURN) return `Error: this turn already started ${MAX_SUBAGENTS_PER_TURN} subagents; do the rest yourself or combine tasks.`;
    started += 1;
    const wantsAct = mode === 'act';
    const childMode = wantsAct && ctx.agentMode === 'act' && permissions.has('agent.act') ? 'act' : 'plan';
    const label = name || task.slice(0, 60);
    const id = callId || `sub${started}`;
    const wrap = (ev) => { if (EVENTS_FOR_UI.has(ev.type)) emit({ type: 'subagent_event', id, event: ev }); };
    audit?.('agent.subagent', childMode, { name: label, task: task.slice(0, 300), requested: mode || 'plan' });
    emit({ type: 'subagent_start', id, name: label, task, mode: childMode, downgraded: wantsAct && childMode !== 'act' });

    await parallel.acquire();
    if (childMode === 'act') await actLock.acquire(); // act children edit files, so they run one at a time
    let report = null, finalText = '', outcome = 'complete';
    try {
      if (childMode === 'act') { const cp = await createCheckpoint(ctx.projectId, ctx.root, { label: `Before subagent: ${label}`.slice(0, 120), author: 'agent', dataDir: ctx.dataDir }); ctx.markCheckpoint?.(cp); wrap({ type: 'checkpoint', ...cp }); }
      const childCtx = {
        ...ctx, agentMode: childMode, isSubagent: true, subagents: false, skills: [],
        askUser: undefined, onPlan: undefined, onModeRequest: undefined, onModeChange: undefined, onSkill: undefined,
        onConclude: (c) => { report = c; }, onChange: (p) => wrap({ type: 'file_changed', path: p }), onCheckpoint: (cp) => wrap({ type: 'checkpoint', ...cp }),
        approve: ctx.approve ? (command) => ctx.approve(command, { agent: label }) : undefined,
      };
      const messages = [{ role: 'user', content: task }];
      const sys = `${DEFAULT_SUBAGENT_PROMPT}${childMode === 'plan' ? PLAN_SAFETY_CLAUSE : ACT_SAFETY_CLAUSE}${effortNote(effort)}`;
      const r = await runAgentTurn({ adapter, model, system: sys, messages, ctx: childCtx, emit: wrap, signal, maxIterations: Math.min(15, maxIterations), maxTokens, temperature, thinking, audit, onUsage });
      finalText = r.text || messages.filter((m) => m.role === 'assistant').at(-1)?.content || '';
      if (r.stopped === 'max_iterations') outcome = 'partial';
      if (report?.status && report.status !== 'complete') outcome = report.status;
    } catch (e) {
      outcome = 'blocked'; finalText = signal?.aborted ? 'Canceled.' : `The subagent failed: ${String(e.message).slice(0, 200)}`;
    } finally { if (childMode === 'act') actLock.release(); parallel.release(); }

    const body = report
      ? [`Subagent "${label}" (${childMode} mode) finished: ${report.status}.`, report.summary, report.changes?.length ? `Files changed: ${report.changes.join(', ')}` : '', report.verification ? `Verification: ${report.verification}` : '', report.next_steps?.length ? `Suggested next steps: ${report.next_steps.join('; ')}` : ''].filter(Boolean).join('\n\n')
      : `Subagent "${label}" (${childMode} mode) ended without a formal report (${outcome}).\n\n${finalText || '(no output)'}`;
    emit({ type: 'subagent_done', id, status: outcome, summary: (report?.summary || finalText || '').slice(0, 2000) });
    return body.length > RESULT_CAP ? `${body.slice(0, RESULT_CAP)}\n[report truncated]` : body;
  };
}
