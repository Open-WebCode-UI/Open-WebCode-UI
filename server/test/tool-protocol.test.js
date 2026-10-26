import { describe, it, expect } from 'vitest';
import { runAgentTurn } from '../src/agent/loop.js';
import { findPseudoCall, validateArgs } from '../src/agent/tool-protocol.js';
import { TOOL_DEFS } from '../src/agent/tools.js';
import { buildRequest as anthropicReq } from '../src/llm/anthropic.js';
import { buildRequest as openaiReq } from '../src/llm/openai.js';
import { buildRequest as bedrockReq } from '../src/llm/bedrock.js';
import { fakeAdapterFactory, tmpDir } from './helpers.js';

const tools = [TOOL_DEFS.conclude, TOOL_DEFS.search, TOOL_DEFS.propose_plan];
const SCREENSHOT = 'I have created ten files.\n\nconclude { "status": "complete", "summary": "Created ten example files." }';

const mk = (script) => {
  const events = [], seen = [], messages = [{ role: 'user', content: 'go' }];
  const adapter = fakeAdapterFactory(script, seen)();
  const ctx = { root: tmpDir('tp-'), projectId: 1, execMode: 'files_only', agentMode: 'act', permissions: new Set(), secretGlobs: [], dataDir: tmpDir('d-'), onConclude: (c) => events.push({ type: 'conclusion', ...c }) };
  return { events, seen, messages, run: () => runAgentTurn({ adapter, model: 'm', system: 's', messages, ctx, emit: (e) => events.push(e), maxIterations: 8 }) };
};
const conclude = (args) => [{ type: 'tool_call', id: 'c1', name: 'conclude', args }];

describe('detecting tool calls written as text', () => {
  it('flags call syntax for a registered tool, including the screenshot case', () => {
    expect(findPseudoCall(SCREENSHOT, tools)).toBe('conclude');
    expect(findPseudoCall('propose_plan(plan="""# x""")', tools)).toBe('propose_plan');
    expect(findPseudoCall('<conclude>{"summary":"x"}</conclude>', tools)).toBe('conclude');
  });
  it('ignores ordinary prose and unregistered tools', () => {
    expect(findPseudoCall('I will search the repo and then conclude that it works.', tools)).toBeNull();
    expect(findPseudoCall('Use the search (regex) tool', tools)).toBeNull();
    expect(findPseudoCall('write_file { "path": "a" }', tools)).toBeNull();
  });
  it('validates required fields, types, and enums', () => {
    expect(validateArgs(TOOL_DEFS.conclude, { summary: 'ok', status: 'complete' })).toEqual([]);
    expect(validateArgs(TOOL_DEFS.conclude, { status: 'done' })).toEqual(['"summary" is required', '"status" must be one of "complete", "partial", "blocked"']);
    expect(validateArgs(TOOL_DEFS.conclude, { summary: 'x', status: 'complete', changes: 'a.js' })).toEqual(['"changes" must be of type array']);
  });
});

describe('recovering from a tool call written as text', () => {
  it('reprompts once and accepts the real call', async () => {
    const t = mk([[{ type: 'text', text: SCREENSHOT }], conclude({ summary: 'Done', status: 'complete' })]);
    expect((await t.run()).stopped).toBe('handed_back');
    expect(t.seen).toHaveLength(2);
    expect(t.seen[1].messages.at(-1).content).toMatch(/conclude\(\.\.\.\) as plain text/);
    expect(t.seen[1].toolChoice).toBeUndefined();
    expect(t.events.find((e) => e.type === 'conclusion')).toMatchObject({ summary: 'Done' });
  });
  it('forces the tool on the last retry, then stops with an error instead of accepting the text', async () => {
    const bad = [{ type: 'text', text: SCREENSHOT }];
    const t = mk([bad, bad, bad]);
    const r = await t.run();
    expect(r.stopped).toBe('protocol_error');
    expect(t.seen.map((s) => s.toolChoice)).toEqual([undefined, undefined, { name: 'conclude' }]);
    expect(t.seen[2].toolChoice).toEqual({ name: 'conclude' });
    expect(t.events.at(-1)).toMatchObject({ type: 'error' });
    expect(t.events.some((e) => e.type === 'done')).toBe(false);
  });
  it('still accepts an ordinary text answer', async () => {
    expect((await (await mk([[{ type: 'text', text: 'The answer is 42.' }]])).run()).stopped).toBe('complete');
  });
  it('returns schema errors for a conclude with missing arguments, so the model can retry', async () => {
    const t = mk([conclude({ status: 'complete' }), conclude({ summary: 'Fixed', status: 'complete' })]);
    expect((await t.run()).stopped).toBe('handed_back');
    expect(t.messages.find((m) => m.role === 'tool').content).toMatch(/^Error: .*"summary" is required/);
    expect(t.events.filter((e) => e.type === 'conclusion')).toHaveLength(1);
  });
});

describe('forcing a tool in provider requests', () => {
  const base = { system: 's', messages: [{ role: 'user', content: 'x' }], tools, model: 'm', maxTokens: 100, toolChoice: { name: 'conclude' } };
  it('maps to each provider format', () => {
    expect(anthropicReq(base).tool_choice).toEqual({ type: 'tool', name: 'conclude' });
    expect(openaiReq(base, { type: 'openai' }).tool_choice).toEqual({ type: 'function', function: { name: 'conclude' } });
    expect(bedrockReq(base).toolConfig.toolChoice).toEqual({ tool: { name: 'conclude' } });
  });
  it('is skipped where the provider rejects it', () => {
    expect(anthropicReq({ ...base, thinking: { mode: 'adaptive' } }).tool_choice).toBeUndefined();
    expect(bedrockReq({ ...base, thinking: { mode: 'adaptive' } }).toolConfig.toolChoice).toBeUndefined();
    expect(openaiReq(base, { type: 'lmstudio' }).tool_choice).toBeUndefined();
    expect(openaiReq(base, { type: 'ollama' }).tool_choice).toBeUndefined();
    expect(openaiReq(base, { type: 'generic' }).tool_choice).toBeUndefined();
    // Mistral: 9-character alphanumeric tool-call ids, no stream_options, max_tokens
    const msgs = [{ role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'x', args: {} }, { id: 'AbC123xyz', name: 'y', args: {} }] }, { role: 'tool', toolCallId: 'call_0', name: 'x', content: 'r' }];
    const mr = openaiReq({ ...base, messages: msgs }, { type: 'mistral' });
    const ids = mr.messages[1].tool_calls.map((c) => c.id);
    expect(ids[0]).toMatch(/^[A-Za-z0-9]{9}$/); expect(ids[1]).toBe('AbC123xyz');
    expect(mr.messages[2].tool_call_id).toBe(ids[0]);
    expect(mr.stream_options).toBeUndefined();
    expect(openaiReq({ ...base, messages: msgs }).messages[1].tool_calls[0].id).toBe('call_0');
    expect(anthropicReq({ ...base, toolChoice: undefined }).tool_choice).toBeUndefined();
  });
});
