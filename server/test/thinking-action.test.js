import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runAgentTurn } from '../src/agent/loop.js';
import { writeIntentIn } from '../src/agent/tool-protocol.js';
import { fakeAdapterFactory, tmpDir } from './helpers.js';

const tools = [{ name: 'write_file' }, { name: 'conclude' }, { name: 'read_file' }];

describe('writeIntentIn', () => {
  it('flags a decided file change named in reasoning', () => {
    const t = "I've got requirements.txt written. I'll skip further planning and produce the full gan.ipynb in one write_file call. Then";
    expect(writeIntentIn(t, tools)).toMatchObject({ kind: 'intent', tool: 'write_file' });
  });
  it('flags a tool call written out as text in reasoning', () => {
    expect(writeIntentIn('Plan: write_file { "path": "a.py", "content": "x" } and then', tools)).toMatchObject({ kind: 'call', tool: 'write_file' });
  });
  it('flags a file name with a write intent even without a tool name', () => {
    expect(writeIntentIn("OK. Now I'll create train.py with the training loop. Next", tools)).toMatchObject({ kind: 'intent' });
  });
  it('does not flag ordinary planning, reading, or questions', () => {
    expect(writeIntentIn('I need to think about the loss function and the batch size. Let me read the config first. Still', tools)).toBeNull();
    expect(writeIntentIn('Should I read the file first? I will check the tests. Then', tools)).toBeNull();
  });
  it('ignores the last, possibly unfinished, piece', () => {
    expect(writeIntentIn("I'll write gan.ipynb with write_file", tools)).toBeNull();
  });
});

const mk = (script) => {
  const root = tmpDir('tact-'); const events = []; const audits = []; const messages = [{ role: 'user', content: 'go' }]; const seen = [];
  const adapter = fakeAdapterFactory(script, seen)();
  const ctx = { root, projectId: 1, execMode: 'files_only', agentMode: 'act', permissions: new Set(), secretGlobs: [], dataDir: tmpDir('d-') };
  const run = () => runAgentTurn({ adapter, model: 'm', system: 's', messages, ctx, emit: (e) => events.push(e), audit: (a, t, d) => audits.push([a, t, d]), maxIterations: 6 });
  return { root, events, messages, run, seen, audits };
};
const call = (name, args, id) => ({ type: 'tool_call', id, name, args });

describe('reasoning that describes a write instead of making it', () => {
  it('cuts the stream, asks for the call, and the write then happens', async () => {
    const t = mk([
      [{ type: 'thinking', text: "I'll skip planning and write gan.ipynb in one write_file call now. Then" }, call('write_file', { path: 'never.txt', content: 'x' }, 'bad')],
      [call('write_file', { path: 'gan.ipynb', content: '{}' }, 'w1')],
      [{ type: 'text', text: 'Done' }],
    ]);
    const r = await t.run();
    expect(r.stopped).toBe('complete');
    expect(fs.existsSync(path.join(t.root, 'never.txt'))).toBe(false); // the call that followed the reasoning in the cut stream never ran
    expect(fs.readFileSync(path.join(t.root, 'gan.ipynb'), 'utf8')).toBe('{}');
    expect(t.messages.find((m) => /Platform notice/.test(m.content || ''))?.content).toMatch(/no tool call was made/);
    expect(t.audits.some(([a, , d]) => a === 'agent.thinking_action' && d.tool === 'write_file')).toBe(true);
    expect(t.events.some((e) => e.type === 'notice' && /asked to make the change/.test(e.text))).toBe(true);
  });

  it('does not cut when a tool call is already in the stream', async () => {
    const t = mk([
      [call('write_file', { path: 'ok.txt', content: 'x' }, 'w1')],
      [{ type: 'text', text: 'Done' }],
    ]);
    await t.run();
    expect(fs.existsSync(path.join(t.root, 'ok.txt'))).toBe(true);
    expect(t.audits.some(([a]) => a === 'agent.thinking_action')).toBe(false);
  });

  it('does not cut ordinary reasoning', async () => {
    const t = mk([
      [{ type: 'thinking', text: 'Let me read the config and check the tests first. Then I will decide. Still' }, { type: 'text', text: 'Here is my answer.' }],
    ]);
    expect((await t.run()).stopped).toBe('complete');
    expect(t.audits.some(([a]) => a === 'agent.thinking_action')).toBe(false);
  });

  it('shares the retry budget and stops rather than looping', async () => {
    const reasoning = () => [{ type: 'thinking', text: "I'll write a.txt with write_file now. Then" }];
    const t = mk([reasoning(), reasoning(), reasoning(), reasoning()]);
    const r = await t.run();
    expect(r.stopped).toBe('idle_reply');
  });
});
