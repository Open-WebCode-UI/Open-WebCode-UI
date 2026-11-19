import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runAgentTurn } from '../src/agent/loop.js';
import { fakeAdapterFactory, tmpDir } from './helpers.js';

const mk = (script, over = {}) => {
  const root = tmpDir('idle-'); const events = []; const audits = []; const messages = [{ role: 'user', content: 'go' }]; const seen = [];
  const adapter = fakeAdapterFactory(script, seen)();
  const ctx = { root, projectId: 1, execMode: 'files_only', agentMode: 'act', permissions: new Set(), secretGlobs: [], dataDir: tmpDir('d-'), ...over };
  const run = () => runAgentTurn({ adapter, model: 'm', system: 's', messages, ctx, emit: (e) => events.push(e), audit: (a, t, d) => audits.push([a, d]), maxIterations: 6 });
  return { root, events, messages, run, seen, audits };
};
const call = (name, args, id) => ({ type: 'tool_call', id, name, args });
const thinking = (text) => [{ type: 'thinking', text }];

describe('empty Act-mode replies', () => {
  it('nudges a reasoning-only reply to act, and the write then happens', async () => {
    const t = mk([thinking('I will write a.txt'), [call('write_file', { path: 'a.txt', content: 'x' }, 'w1')], [{ type: 'text', text: 'Done' }]]);
    const r = await t.run();
    expect(r).toMatchObject({ stopped: 'complete' });
    expect(fs.readFileSync(path.join(t.root, 'a.txt'), 'utf8')).toBe('x');
    const nudge = t.messages.find((m) => m.role === 'user' && /Platform notice/.test(m.content));
    expect(nudge).toBeTruthy();
    expect(t.audits.some(([a]) => a === 'agent.idle_reply')).toBe(true);
  });

  it('keeps an empty assistant message from being sent with empty content', async () => {
    const t = mk([thinking('plan only'), [{ type: 'text', text: 'ok' }]]);
    await t.run();
    expect(t.seen[1].messages.find((m) => m.role === 'assistant').content).toMatch(/No reply/);
  });

  it('stops after the nudge limit instead of looping', async () => {
    const t = mk([thinking('a'), thinking('b'), thinking('c'), thinking('d')]);
    const r = await t.run();
    expect(r.stopped).toBe('idle_reply');
    expect(t.events.at(-1)).toMatchObject({ type: 'error' });
  });

  it('does not nudge in Plan mode or when the reply has text', async () => {
    const plan = mk([thinking('only thoughts')], { agentMode: 'plan' });
    expect((await plan.run()).stopped).toBe('complete');
    const text = mk([[{ type: 'text', text: 'Here is the answer.' }]]);
    expect((await text.run()).stopped).toBe('complete');
  });

  it('names the output limit in the nudge when the reply was cut off', async () => {
    const t = mk([[{ type: 'thinking', text: 'long' }, { type: 'done', stop: 'length' }], [{ type: 'text', text: 'ok' }]]);
    // The fake adapter appends its own done event; the script's done comes first, so the loop sees stop 'length'.
    await t.run();
    expect(t.messages.find((m) => /Platform notice/.test(m.content || ''))?.content).toMatch(/output limit/);
  });
});
