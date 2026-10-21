import { describe, it, expect } from 'vitest';
import { runAgentTurn } from '../src/agent/loop.js';

describe('tool calls with broken arguments', () => {
  it('are not executed and tell the model why', async () => {
    const calls = [{ type: 'tool_call', id: 'x1', name: 'write_file', args: { _parseError: true, raw: '{"path":"a.js","content":"cut off' } }];
    let n = 0;
    const adapter = { async *stream() { if (n++ === 0) { for (const c of calls) yield c; } else yield { type: 'text', text: 'ok' }; yield { type: 'done' }; } };
    const messages = [{ role: 'user', content: 'go' }], events = [];
    await runAgentTurn({ adapter, model: 'm', system: '', messages, ctx: { agentMode: 'act', permissions: new Set(['files.write']), execMode: 'files_only' }, emit: (e) => events.push(e) });
    const res = events.find((e) => e.type === 'tool_result');
    expect(res.result).toMatch(/^Error: The arguments of this tool call were incomplete/);
    expect(messages.find((m) => m.role === 'tool').content).toMatch(/output limit/);
  });
});
