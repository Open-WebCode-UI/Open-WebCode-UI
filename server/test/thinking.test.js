import Database from 'better-sqlite3';
import { legacySchema } from '../src/db/legacy-migrate.js';
import { sqlDb } from './db-sql.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { ThinkSplitter, defaultThinking, replayable } from '../src/llm/thinking.js';
import { anthropicAdapter, buildRequest as antReq } from '../src/llm/anthropic.js';
import { bedrockAdapter, buildRequest as bedReq } from '../src/llm/bedrock.js';
import { openaiAdapter, buildRequest as buildOpenai } from '../src/llm/openai.js';
import { runAgentTurn } from '../src/agent/loop.js';
import { freshDb, createApp, login, addProvider, fakeAdapterFactory, tmpDir } from './helpers.js';
import { openDb } from '../src/db/index.js';

async function collect(it) { const out = []; for await (const e of it) out.push(e); return out; }
async function* gen(items) { for (const i of items) yield i; }
const feedAll = (chunks) => { const s = new ThinkSplitter(); const out = chunks.flatMap((c) => s.feed(c)).concat(s.flush()); const j = (k) => out.filter((p) => p.kind === k).map((p) => p.text).join(''); return { text: j('text'), thinking: j('thinking') }; };

describe('ThinkSplitter (<think> tags inside the content stream)', () => {
  it('separates reasoning from the answer', () => { expect(feedAll(['<think>plan it</think>Answer'])).toEqual({ text: 'Answer', thinking: 'plan it' }); });
  it('handles tags split across chunks at every boundary', () => {
    const full = 'Hi <think>step one\nstep two</think>Done.';
    for (let i = 1; i < full.length; i++) expect(feedAll([full.slice(0, i), full.slice(i)])).toEqual({ text: 'Hi Done.', thinking: 'step one\nstep two' });
    expect(feedAll(full.split(''))).toEqual({ text: 'Hi Done.', thinking: 'step one\nstep two' }); // one character at a time
  });
  it('does not swallow text that merely looks like a tag, and flushes incomplete tails', () => {
    expect(feedAll(['a < b and <thin', 'g> done'])).toEqual({ text: 'a < b and <thing> done', thinking: '' });
    expect(feedAll(['<think>never closed'])).toEqual({ text: '', thinking: 'never closed' });
    expect(feedAll(['ends with <thi'])).toEqual({ text: 'ends with <thi', thinking: '' });
  });
});

describe('default thinking suggestions', () => {
  it.each([
    ['anthropic', 'claude-opus-5-5', 'adaptive'], ['anthropic', 'claude-sonnet-5-5', 'adaptive'], ['anthropic', 'claude-fable-5-1', 'adaptive'], ['anthropic', 'claude-opus-4-7', 'adaptive'],
    ['anthropic', 'claude-haiku-4-5', 'budget'], ['anthropic', 'claude-sonnet-4-5', 'budget'], ['anthropic', 'claude-3-7-sonnet', 'budget'],
    ['bedrock', 'anthropic.claude-opus-5-5', 'adaptive'], ['bedrock', 'amazon.nova-pro', 'off'], ['openai', 'gpt-4o', 'off'], ['lmstudio', 'deepseek-r1', 'off'], ['anthropic', 'something-else', 'off'],
  ])('%s %s -> %s', (type, id, mode) => { expect(defaultThinking(type, id).mode).toBe(mode); });
});

describe('Anthropic thinking', () => {
  const base = { system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], model: 'claude-opus-5-5', maxTokens: 1000, temperature: 0.3 };
  it('adaptive: requests summarized display and drops temperature', () => {
    const r = antReq({ ...base, thinking: { mode: 'adaptive' } });
    expect(r.thinking).toEqual({ type: 'adaptive', display: 'summarized' }); expect(r.temperature).toBeUndefined();
  });
  it('budget: enabled+budget_tokens and max_tokens always above the budget', () => {
    const r = antReq({ ...base, model: 'claude-haiku-4-5', thinking: { mode: 'budget', budget: 8000 } });
    expect(r.thinking).toEqual({ type: 'enabled', budget_tokens: 8000 }); expect(r.max_tokens).toBeGreaterThan(8000);
  });
  it('off: no thinking param and temperature kept', () => {
    const r = antReq({ ...base, thinking: { mode: 'off' } }); expect(r.thinking).toBeUndefined(); expect(r.temperature).toBe(0.3);
  });
  it('streams thinking deltas, then emits the signed block for replay', async () => {
    const evs = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG123' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'ENC' } }, { type: 'content_block_stop', index: 1 },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Answer' } },
    ];
    const out = await collect(anthropicAdapter({ cfg: {}, secret: 'k', client: { messages: { create: async () => gen(evs) } } }).stream({ ...base, thinking: { mode: 'adaptive' } }));
    expect(out.filter((e) => e.type === 'thinking').map((e) => e.text).join('')).toBe('Let me think.');
    const blocks = out.filter((e) => e.type === 'thinking_block');
    expect(blocks[0]).toEqual({ type: 'thinking_block', model: 'claude-opus-5-5', block: { type: 'thinking', thinking: 'Let me think.', signature: 'SIG123' } });
    expect(blocks[1].block).toEqual({ type: 'redacted_thinking', data: 'ENC' });
    expect(out.find((e) => e.type === 'text').text).toBe('Answer');
  });
  it('replays thinking blocks first, unchanged, only to the same model', () => {
    const msg = { role: 'assistant', content: 'ok', toolCalls: [{ id: 't', name: 'x', args: {} }], thinkingBlocks: [{ model: 'claude-opus-5-5', block: { type: 'thinking', thinking: 'a', signature: 'S' } }] };
    const same = antReq({ ...base, messages: [{ role: 'user', content: 'q' }, msg, { role: 'tool', toolCallId: 't', content: 'r' }] });
    expect(same.messages[1].content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
    expect(same.messages[1].content[0]).toEqual({ type: 'thinking', thinking: 'a', signature: 'S' });
    const other = antReq({ ...base, model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'q' }, msg, { role: 'tool', toolCallId: 't', content: 'r' }] });
    expect(other.messages[1].content.map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect(replayable(msg, 'other-model')).toEqual([]);
  });
});

describe('Bedrock reasoning', () => {
  const base = { system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], model: 'anthropic.claude-opus-5-5', maxTokens: 1000, temperature: 0.3 };
  it('passes the thinking config through additionalModelRequestFields (no temperature)', () => {
    const r = bedReq({ ...base, thinking: { mode: 'adaptive' } });
    expect(r.additionalModelRequestFields).toEqual({ thinking: { type: 'adaptive', display: 'summarized' } }); expect(r.inferenceConfig.temperature).toBeUndefined();
    expect(bedReq({ ...base, thinking: { mode: 'budget', budget: 4000 } }).inferenceConfig.maxTokens).toBeGreaterThan(4000);
    expect(bedReq({ ...base, thinking: { mode: 'off' } }).additionalModelRequestFields).toBeUndefined();
  });
  it('streams reasoningContent and stores signed + redacted blocks, then replays them', async () => {
    const evs = [
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'hmm ' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'ok' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'BSIG' } } } }, { contentBlockStop: { contentBlockIndex: 0 } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { reasoningContent: { redactedContent: new Uint8Array([1, 2, 3]) } } } }, { contentBlockStop: { contentBlockIndex: 1 } },
      { contentBlockDelta: { contentBlockIndex: 2, delta: { text: 'Answer' } } },
    ];
    const out = await collect(bedrockAdapter({ cfg: {}, secret: '', client: { send: async () => ({ stream: gen(evs) }) } }).stream({ ...base, thinking: { mode: 'adaptive' } }));
    expect(out.filter((e) => e.type === 'thinking').map((e) => e.text).join('')).toBe('hmm ok');
    const [a, b] = out.filter((e) => e.type === 'thinking_block');
    expect(a.block).toEqual({ kind: 'text', text: 'hmm ok', signature: 'BSIG' }); expect(b.block).toMatchObject({ kind: 'redacted', b64: 'AQID' });
    const replay = bedReq({ ...base, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'x', thinkingBlocks: [a, b].map((e) => ({ model: e.model, block: e.block })) }] });
    expect(replay.messages[1].content[0]).toEqual({ reasoningContent: { reasoningText: { text: 'hmm ok', signature: 'BSIG' } } });
    expect(Buffer.from(replay.messages[1].content[1].reasoningContent.redactedContent)).toEqual(Buffer.from([1, 2, 3]));
  });
});

describe('OpenAI-compatible reasoning', () => {
  const run = async (chunks) => collect(openaiAdapter({ type: 'lmstudio', cfg: {}, secret: '', client: { chat: { completions: { create: async () => gen(chunks) } } } }).stream({ system: 's', messages: [], tools: [], model: 'm', maxTokens: 10 }));
  it.each(['reasoning_content', 'reasoning'])('streams delta.%s as thinking', async (field) => {
    const out = await run([{ choices: [{ delta: { [field]: 'let me ' } }] }, { choices: [{ delta: { [field]: 'see' } }] }, { choices: [{ delta: { content: 'Result' } }] }]);
    expect(out.filter((e) => e.type === 'thinking').map((e) => e.text).join('')).toBe('let me see');
    expect(out.filter((e) => e.type === 'text').map((e) => e.text).join('')).toBe('Result');
  });
  it('splits inline <think> tags out of the content stream, even across chunks', async () => {
    const out = await run([{ choices: [{ delta: { content: '<thi' } }] }, { choices: [{ delta: { content: 'nk>reasoning</th' } }] }, { choices: [{ delta: { content: 'ink>The answer' } }] }]);
    expect(out.filter((e) => e.type === 'thinking').map((e) => e.text).join('')).toBe('reasoning');
    expect(out.filter((e) => e.type === 'text').map((e) => e.text).join('')).toBe('The answer');
  });
});

describe('agent loop + persistence', () => {
  it('emits thinking events, keeps them (and signed blocks) on the assistant message', async () => {
    const script = [[{ type: 'thinking', text: 'consider ' }, { type: 'thinking', text: 'options' }, { type: 'thinking_block', model: 'm', block: { type: 'thinking', thinking: 'consider options', signature: 'S' } }, { type: 'text', text: 'Final' }]];
    const events = [], messages = [{ role: 'user', content: 'go' }];
    await runAgentTurn({ adapter: fakeAdapterFactory(script)(), model: 'm', system: 's', messages, ctx: { agentMode: 'chat', permissions: new Set() }, emit: (e) => events.push(e), maxIterations: 1, thinking: { mode: 'adaptive' } });
    expect(events.filter((e) => e.type === 'thinking').map((e) => e.text).join('')).toBe('consider options');
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Final', thinking: 'consider options', thinkingBlocks: [{ model: 'm', block: { signature: 'S' } }] });
  });

  it('passes the model\'s thinking setting to the adapter and streams/persists thinking over HTTP (chat + agent)', async () => {
    await freshDb(); const modelId = await addProvider();
    (await sqlDb().prepare("UPDATE models SET thinking_mode='adaptive' WHERE id=?").run(modelId));
    const seen = [];
    const factory = () => ({ async *stream(args) { seen.push(args.thinking); yield { type: 'thinking', text: 'pondering' }; yield { type: 'text', text: 'hello' }; yield { type: 'done' }; } });
    const app = createApp({ deps: { adapterFactory: factory } });
    const u = await login(app, { username: 'thinker1' });
    const res = await u.post('/api/chat/turn').send({ message: 'hi', modelId }).buffer(true).parse((r, cb) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => cb(null, d)); });
    const events = res.body.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.slice(6)));
    expect(events.map((e) => e.type)).toEqual(['start', 'phase', 'phase', 'thinking', 'text', 'done']);
    expect(seen[0]).toEqual({ mode: 'adaptive', budget: null });
    const conv = events[0].conversationId;
    expect((await u.get(`/api/conversations/${conv}/messages`)).body[1]).toMatchObject({ role: 'assistant', content: 'hello', thinking: 'pondering' });
  });
});

describe('model thinking settings API and migration', () => {
  it('defaults by model name, accepts explicit settings, and the enable toggle never resets them', async () => {
    await freshDb(); const app = createApp();
    const admin = await login(app, { username: 'provadmin', roles: ['administrator'] });
    const p = (await admin.post('/api/admin/providers').send({ name: 'Anth', type: 'anthropic', config: {}, secret: 'k' })).body;
    const add = (body) => admin.post(`/api/admin/providers/${p.id}/models`).send(body);
    let m = (await add({ modelId: 'claude-opus-5-5' })).body.models.find((x) => x.modelId === 'claude-opus-5-5');
    expect(m).toMatchObject({ thinkingMode: 'adaptive', thinkingBudget: null });
    m = (await add({ modelId: 'claude-haiku-4-5' })).body.models.find((x) => x.modelId === 'claude-haiku-4-5');
    expect(m).toMatchObject({ thinkingMode: 'budget', thinkingBudget: 8000 });
    await add({ modelId: 'claude-haiku-4-5', thinkingMode: 'budget', thinkingBudget: 16000 });
    const toggled = (await add({ modelId: 'claude-haiku-4-5', enabled: false })).body.models.find((x) => x.modelId === 'claude-haiku-4-5'); // no thinking fields sent
    expect(toggled).toMatchObject({ enabled: false, thinkingMode: 'budget', thinkingBudget: 16000 });
    expect((await add({ modelId: 'x', thinkingMode: 'turbo' })).status).toBe(400);
    expect((await add({ modelId: 'x', thinkingMode: 'budget', thinkingBudget: 10 })).status).toBe(400);
    const off = (await add({ modelId: 'claude-opus-5-5', thinkingMode: 'off' })).body.models.find((x) => x.modelId === 'claude-opus-5-5');
    expect(off).toMatchObject({ thinkingMode: 'off', thinkingBudget: null });
  });
  it('adds the new columns to a database created before this feature existed', async () => {
    const dir = tmpDir('migr-'); const file = `${dir}/old.db`;
    const old = new Database(file);
    old.exec(legacySchema);
    old.exec('ALTER TABLE models DROP COLUMN thinking_mode; ALTER TABLE models DROP COLUMN thinking_budget;');
    old.close();
    const again = await openDb(file);
    expect((await again.raw('PRAGMA table_info(models)')).map((c) => c.name)).toEqual(expect.arrayContaining(['thinking_mode', 'thinking_budget']));
    await again.destroy();
  });
});

describe('Gemini thought summaries (OpenAI-compatible endpoint)', () => {
  it('requests them only when thinking is on, and splits <thought> tags into thinking', async () => {
    const { buildRequest } = await import('../src/llm/openai.js');
    const base = { system: 's', messages: [], model: 'gemini-2.5-pro', maxTokens: 100 };
    expect(buildRequest({ ...base, thinking: { mode: 'adaptive' } }, { type: 'gemini' }).extra_body).toEqual({ google: { thinking_config: { include_thoughts: true } } });
    expect(buildRequest({ ...base, thinking: { mode: 'off' } }, { type: 'gemini' }).extra_body).toBeUndefined();
    expect(buildRequest({ ...base, thinking: { mode: 'adaptive' } }, { type: 'openai' }).extra_body).toBeUndefined();
    const s = new ThinkSplitter('thought'); const out = [...s.feed('<thought>hm'), ...s.feed('m</thought>Hi'), ...s.flush()];
    expect(out.map((p) => `${p.kind}:${p.text}`)).toEqual(['thinking:hm', 'thinking:m', 'text:Hi']);
  });
});

describe('Gemini thought signatures on tool calls', () => {
  const call = { id: 'c1', name: 'web_search', args: { q: 'x' } };
  const hist = (blocks) => [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', toolCalls: [call], ...(blocks ? { thinkingBlocks: blocks } : {}) }, { role: 'tool', toolCallId: 'c1', content: 'r' }];
  const sigOf = (messages, model = 'gemini-3-pro-preview') => buildOpenai({ system: 's', messages, model, maxTokens: 10 }, { type: 'gemini' }).messages[2].tool_calls[0].extra_content?.google?.thought_signature;
  it('echoes the captured signature, falls back to the placeholder, and skips non-Gemini-3', () => {
    expect(sigOf(hist([{ model: 'gemini-3-pro-preview', block: { callId: 'c1', signature: 'SIG' } }]))).toBe('SIG');
    expect(sigOf(hist())).toBe('skip_thought_signature_validator');
    expect(sigOf(hist(), 'gemini-2.5-pro')).toBeUndefined();
  });
  it('captures the signature from the stream and yields it before the tool call', async () => {
    const chunks = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'web_search', arguments: '{"q":"x"}' }, extra_content: { google: { thought_signature: 'SIG' } } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }];
    const ad = openaiAdapter({ type: 'gemini', cfg: {}, secret: 'k', client: { chat: { completions: { create: async () => gen(chunks) } } } });
    const evs = await collect(ad.stream({ system: 's', messages: [], model: 'gemini-3-pro-preview', maxTokens: 10 }));
    const i = evs.findIndex((e) => e.type === 'thinking_block');
    expect(evs[i]).toMatchObject({ model: 'gemini-3-pro-preview', block: { callId: 'c1', signature: 'SIG' } });
    expect(evs[i + 1]).toMatchObject({ type: 'tool_call', id: 'c1' });
  });
});
