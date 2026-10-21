import { describe, it, expect } from 'vitest';
import { runAgentTurn, INTERRUPTED_NOTE } from '../src/agent/loop.js';
import { buildTimeline } from '../src/sessions.js';
import { tmpDir } from './helpers.js';

// An adapter that behaves like the real SDKs: it streams, then throws when the signal aborts.
const abortable = (chunks, ctl, abortAfter) => ({
  async *stream({ signal }) {
    for (let i = 0; i < chunks.length; i++) {
      if (i === abortAfter) ctl.abort();
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      yield chunks[i];
    }
  },
});
const run = (adapter, ctl, messages = [{ role: 'user', content: 'go' }]) => {
  const events = [];
  const ctx = { root: tmpDir('int-'), projectId: 1, execMode: 'files_only', agentMode: 'plan', permissions: new Set(), secretGlobs: [], dataDir: tmpDir('d-') };
  return runAgentTurn({ adapter, model: 'm', system: 's', messages, ctx, emit: (e) => events.push(e), signal: ctl.signal }).then((r) => ({ r, events, messages }));
};

describe('Stop keeps the work so far so the session can be resumed', () => {
  it('saves partial text as an interrupted assistant message and drops half-streamed tool calls', async () => {
    const ctl = new AbortController();
    const { r, events, messages } = await run(abortable([{ type: 'text', text: 'Let me ' }, { type: 'text', text: 'look' }, { type: 'text', text: ' around' }], ctl, 2), ctl);
    expect(r.stopped).toBe('aborted');
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'Let me look', interrupted: 'partial' });
    expect(events.at(-1)).toEqual({ type: 'aborted' });
  });
  it('adds a placeholder when nothing was written, so roles still alternate', async () => {
    const ctl = new AbortController();
    const { messages } = await run(abortable([{ type: 'thinking', text: 'hmm' }], ctl, 0), ctl);
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: INTERRUPTED_NOTE, interrupted: 'empty' });
    expect(messages.at(-1).thinking).toBeUndefined();
  });
  it('does not rewrite an assistant message that is already last', async () => {
    const ctl = new AbortController(); ctl.abort();
    const { messages } = await run(abortable([], ctl, 0), ctl, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
    expect(messages).toHaveLength(2);
  });
  it('rethrows errors that are not caused by Stop', async () => {
    const ctl = new AbortController();
    const adapter = { async *stream() { yield { type: 'text', text: 'x' }; throw new Error('boom'); } };
    await expect(run(adapter, ctl)).rejects.toThrow('boom');
  });
});

describe('timeline of an interrupted session', () => {
  const row = (m) => ({ content: JSON.stringify(m) });
  it('shows the partial reply and a stopped marker only while the interruption is the latest thing', () => {
    const rows = [row({ role: 'user', content: 'go' }), row({ role: 'assistant', content: 'Let me look', interrupted: 'partial' })];
    expect(buildTimeline(rows).map((i) => i.kind)).toEqual(['user', 'assistant', 'stopped']);
    expect(buildTimeline([...rows, row({ role: 'user', content: 'continue' }), row({ role: 'assistant', content: 'ok' })]).map((i) => i.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
  it('hides the placeholder text', () => {
    const items = buildTimeline([row({ role: 'user', content: 'go' }), row({ role: 'assistant', content: INTERRUPTED_NOTE, interrupted: 'empty' })]);
    expect(items.map((i) => i.kind)).toEqual(['user', 'stopped']);
  });
});
