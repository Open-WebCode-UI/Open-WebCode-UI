import { describe, it, expect, beforeEach } from 'vitest';
import { runAgentTurn } from '../src/agent/loop.js';
import { prefill } from '../src/agent/prefill.js';
import { fakeAdapterFactory, tmpDir } from './helpers.js';

describe('prefill estimate', () => {
  beforeEach(() => prefill.reset());
  it('has no estimate until a model has been measured, then scales with prompt size', () => {
    expect(prefill.eta('m', 4000)).toBeNull();
    prefill.record('m', 4000, 8000); // 0.5 tokens/ms
    expect(prefill.eta('m', 4000)).toBe(8000);
    expect(prefill.eta('m', 1000)).toBe(2000);
    expect(prefill.eta('other', 4000)).toBeNull();
  });
  it('ignores measurements too small to be meaningful', () => {
    prefill.record('m', 50, 500); prefill.record('m', 4000, 10);
    expect(prefill.eta('m', 4000)).toBeNull();
  });
});

describe('agent loop phases', () => {
  beforeEach(() => prefill.reset());
  const run = async (script) => {
    const events = [], messages = [{ role: 'user', content: 'x'.repeat(4000) }];
    const adapter = fakeAdapterFactory(script, [])();
    const ctx = { root: tmpDir('ph-'), projectId: 1, execMode: 'files_only', agentMode: 'plan', permissions: new Set(), secretGlobs: [], dataDir: tmpDir('d-') };
    await runAgentTurn({ adapter, model: 'm', system: 's', messages, ctx, emit: (e) => events.push(e), maxIterations: 5 });
    return events;
  };
  it('announces prefill before the first token and generating once it arrives, once per model request', async () => {
    const ev = await run([[{ type: 'tool_call', id: 't1', name: 'list_dir', args: { path: '.' } }], [{ type: 'text', text: 'hi' }]]);
    const phases = ev.filter((e) => e.type === 'phase').map((e) => e.phase);
    expect(phases).toEqual(['prefill', 'generating', 'prefill', 'generating']);
    expect(ev.find((e) => e.type === 'phase')).toMatchObject({ phase: 'prefill', tokens: expect.any(Number), etaMs: null });
    expect(ev.findIndex((e) => e.type === 'phase')).toBeLessThan(ev.findIndex((e) => e.type === 'text'));
  });
});
