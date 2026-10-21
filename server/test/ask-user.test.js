import { describe, it, expect } from 'vitest';
import { executeTool, TOOL_DEFS } from '../src/agent/tools.js';

describe('ask_user', () => {
  const run = (args) => { const seen = []; return executeTool('ask_user', args, { agentMode: 'plan', execMode: 'files_only', permissions: new Set(), askUser: async (q, o) => { seen.push([q, o]); return 'ans'; } }).then((r) => ({ r, seen })); };
  it('is open-ended without options, and passes cleaned options for multiple choice', async () => {
    expect((await run({ question: 'Q' })).seen).toEqual([['Q', {}]]);
    expect((await run({ question: 'Q', options: ['only one'] })).seen[0][1]).toEqual({}); // one choice is not a choice
    const { r, seen } = await run({ question: 'Q', options: [' A ', 'A', 'B', '', 7, 'C', 'D', 'E', 'F', 'G'], multiple: true });
    expect(r).toBe('ans'); expect(seen[0][1]).toEqual({ options: ['A', 'B', 'C', 'D', 'E', 'F'], multiple: true });
    expect((await run({ question: 'Q', options: ['A', 'B'] })).seen[0][1]).toEqual({ options: ['A', 'B'], multiple: false });
  });
  it('advertises options in the tool schema', () => { expect(TOOL_DEFS.ask_user.parameters.properties).toHaveProperty('options'); });
});
