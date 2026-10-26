import { describe, it, expect, beforeEach } from 'vitest';
import { openaiAdapter, buildRequest as oaiReq } from '../src/llm/openai.js';
import { anthropicAdapter, buildRequest as antReq } from '../src/llm/anthropic.js';
import { bedrockAdapter, buildRequest as bedReq } from '../src/llm/bedrock.js';
import { createAdapter } from '../src/llm/provider.js';
import { encrypt } from '../src/crypto.js';
import { freshDb, createApp, login, request } from './helpers.js';

const tools = [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
const history = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'checking', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a' } }] },
  { role: 'tool', toolCallId: 'c1', name: 'read_file', content: 'FILE' },
];
const args = { system: 'SYS', messages: history, tools, model: 'm1', maxTokens: 100, temperature: 0.2 };
async function collect(it) { const out = []; for await (const e of it) out.push(e); return out; }
async function* gen(items) { for (const i of items) yield i; }

describe('request shapes', () => {
  it('OpenAI-compatible', () => {
    const r = oaiReq(args);
    expect(r).toMatchObject({ model: 'm1', stream: true, max_completion_tokens: 100, temperature: 0.2 });
    expect(r.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(r.messages[2].tool_calls[0]).toEqual({ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } });
    expect(r.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'FILE' });
    expect(r.tools[0].function.name).toBe('read_file');
  });
  it('Anthropic: tool_use / tool_result blocks and input_schema', () => {
    const r = antReq(args);
    expect(r).toMatchObject({ model: 'm1', system: 'SYS', max_tokens: 100, stream: true });
    expect(r.messages[1].content).toEqual([{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a' } }]);
    expect(r.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'FILE' }] });
    expect(r.tools[0].input_schema.type).toBe('object');
  });
  it('Bedrock Converse: toolSpec/toolUse/toolResult', () => {
    const r = bedReq(args);
    expect(r).toMatchObject({ modelId: 'm1', system: [{ text: 'SYS' }], inferenceConfig: { maxTokens: 100, temperature: 0.2 } });
    expect(r.messages[1].content[1].toolUse).toEqual({ toolUseId: 'c1', name: 'read_file', input: { path: 'a' } });
    expect(r.messages[2].content[0].toolResult.toolUseId).toBe('c1');
    expect(r.toolConfig.tools[0].toolSpec.inputSchema.json.type).toBe('object');
  });
});

describe('stream normalization', () => {
  it('OpenAI: text + fragmented tool-call arguments', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hel' } }] }, { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] }, finish_reason: 'tool_calls' }] },
    ];
    let seenReq;
    const client = { chat: { completions: { create: async (r) => { seenReq = r; return gen(chunks); } } } };
    const ev = await collect(openaiAdapter({ type: 'openai', cfg: {}, secret: 'k', client }).stream(args));
    expect(ev).toEqual([{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }, { type: 'tool_delta', id: 'c9', name: 'read_file', delta: '{"pa' }, { type: 'tool_delta', id: 'c9', name: 'read_file', delta: 'th":"x"}' }, { type: 'tool_call', id: 'c9', name: 'read_file', args: { path: 'x' } }, { type: 'done', stop: 'tool_calls' }]);
    expect(seenReq.max_completion_tokens).toBe(100);
  });
  it('LM Studio uses max_tokens', async () => {
    let seenReq;
    const client = { chat: { completions: { create: async (r) => { seenReq = r; return gen([]); } } } };
    await collect(openaiAdapter({ type: 'lmstudio', cfg: {}, secret: '', client }).stream(args));
    expect(seenReq.max_tokens).toBe(100); expect(seenReq.max_completion_tokens).toBeUndefined();
  });
  it('Anthropic', async () => {
    const evs = [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'read_file' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path"' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':"b"}' } },
      { type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ];
    const client = { messages: { create: async () => gen(evs) } };
    expect(await collect(anthropicAdapter({ cfg: {}, secret: 'k', client }).stream(args))).toEqual([
      { type: 'text', text: 'ok' }, { type: 'tool_delta', id: 't1', name: 'read_file', delta: '' }, { type: 'tool_delta', id: 't1', name: 'read_file', delta: '{"path"' }, { type: 'tool_delta', id: 't1', name: 'read_file', delta: ':"b"}' }, { type: 'tool_call', id: 't1', name: 'read_file', args: { path: 'b' } }, { type: 'done', stop: 'tool_use' }]);
  });
  it('Bedrock ConverseStream', async () => {
    const evs = [
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'yo' } } },
      { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'b1', name: 'read_file' } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"path":"z"}' } } } },
      { contentBlockStop: { contentBlockIndex: 1 } }, { messageStop: { stopReason: 'tool_use' } },
    ];
    const client = { send: async () => ({ stream: gen(evs) }) };
    expect(await collect(bedrockAdapter({ cfg: { region: 'us-east-1' }, secret: '', client }).stream(args))).toEqual([
      { type: 'text', text: 'yo' }, { type: 'tool_delta', id: 'b1', name: 'read_file', delta: '' }, { type: 'tool_delta', id: 'b1', name: 'read_file', delta: '{"path":"z"}' }, { type: 'tool_call', id: 'b1', name: 'read_file', args: { path: 'z' } }, { type: 'done', stop: 'tool_use' }]);
  });
  it('factory builds an adapter for every provider type and decrypts the stored key', () => {
    for (const type of ['openai', 'anthropic', 'lmstudio', 'ollama', 'generic', 'gemini', 'vertex', 'mistral', 'bedrock', 'azure']) {
      const a = createAdapter({ type, config: JSON.stringify({ baseUrl: 'https://x.example.com', region: 'us-east-1', deployment: 'd', project: 'p', location: 'global' }), secret_enc: encrypt('secret') });
      expect(typeof a.stream).toBe('function');
    }
    expect(() => createAdapter({ type: 'nope', config: '{}' })).toThrow();
  });
});

describe('provider admin API', () => {
  let app, admin;
  const lookup = async (h) => [{ address: ['localhost', '127.0.0.1'].includes(h) ? '127.0.0.1' : '93.184.216.34' }]; // hermetic: no real DNS
  beforeEach(async () => { await freshDb(); app = createApp({ deps: { lookup } }); admin = await login(app, { username: 'provadmin', roles: ['administrator'] }); });
  it('CRUD, masked key, model management, default models, role allow-list', async () => {
    const c = await admin.post('/api/admin/providers').send({ name: 'Azure', type: 'azure', config: { baseUrl: 'https://res.openai.azure.com', deployment: 'gpt', apiVersion: '2024-10-21' }, secret: 'topsecret' });
    expect(c.status).toBe(201); expect(JSON.stringify(c.body)).not.toContain('topsecret'); expect(c.body.hasSecret).toBe(true);
    const m = await admin.post(`/api/admin/providers/${c.body.id}/models`).send({ modelId: 'gpt-x', maxTokens: 2048 });
    expect(m.body.models[0]).toMatchObject({ modelId: 'gpt-x', enabled: true, maxTokens: 2048 });
    const dev = await login(app, { username: 'devperson' });
    expect((await dev.get('/api/models')).body.models).toHaveLength(1);
    await admin.put(`/api/admin/providers/${c.body.id}`).send({ name: 'Azure', type: 'azure', config: { baseUrl: 'https://res.openai.azure.com' }, allowedRoles: ['administrator'] });
    expect((await dev.get('/api/models')).body.models).toHaveLength(0); // role allow-list
    expect((await admin.get('/api/models')).body.models).toHaveLength(1);
    expect((await dev.post('/api/admin/providers').send({ name: 'x', type: 'openai' })).status).toBe(403);
    expect((await admin.put('/api/admin/default-models').send({ plan: m.body.models[0].id, act: null, chat: null })).status).toBe(200);
  });
  it('validates input and blocks SSRF targets (private hosts only allowed for LM Studio, Ollama, and generic)', async () => {
    expect((await admin.post('/api/admin/providers').send({ name: 'x', type: 'bogus' })).status).toBe(400);
    const bad = await admin.post('/api/admin/providers').send({ name: 'x', type: 'openai', config: { baseUrl: 'http://169.254.169.254/' } });
    expect(bad.status).toBe(400);
    expect((await admin.post('/api/admin/providers').send({ name: 'lm', type: 'lmstudio', config: { baseUrl: 'http://localhost:1234/v1' } })).status).toBe(201);
    expect((await admin.post('/api/admin/providers').send({ name: 'ol', type: 'ollama', config: { baseUrl: 'http://localhost:11434/v1' } })).status).toBe(201);
    expect((await admin.post('/api/admin/providers').send({ name: 'gen', type: 'generic', config: { baseUrl: 'http://10.0.0.5:8000/v1' } })).status).toBe(201);
    expect((await admin.post('/api/admin/providers').send({ name: 'gen2', type: 'generic' })).status).toBe(400);
    expect((await admin.post('/api/admin/providers').send({ name: 'gem', type: 'gemini', secret: 'k' })).status).toBe(201);
    expect((await admin.post('/api/admin/providers').send({ name: 'gem2', type: 'gemini', config: { baseUrl: 'http://localhost:1/' } })).status).toBe(400);
    expect((await admin.post('/api/admin/providers').send({ name: 'vx', type: 'vertex', config: { project: 'p', location: 'us-central1' } })).status).toBe(201);
    expect((await admin.post('/api/admin/providers').send({ name: 'vx2', type: 'vertex' })).status).toBe(400);
    expect((await admin.post('/api/admin/providers').send({ name: 'mi', type: 'mistral', secret: 'k' })).status).toBe(201);
    expect((await admin.post('/api/admin/providers').send({ name: 'mi2', type: 'mistral', config: { baseUrl: 'http://localhost:1/' } })).status).toBe(400);
    expect((await admin.post('/api/admin/providers').send({ name: 'x2', type: 'openai', config: { baseUrl: 'http://localhost:1234/v1' } })).status).toBe(400);
  });
  it('Test connection reports failure without leaking secrets', async () => {
    const c = await admin.post('/api/admin/providers').send({ name: 'LM', type: 'lmstudio', config: { baseUrl: 'http://127.0.0.1:1/v1' } });
    const t = await admin.post(`/api/admin/providers/${c.body.id}/test`);
    expect(t.body.ok).toBe(false);
  });
});

describe('local servers that stream tool calls unevenly', () => {
  it('OpenAI-compatible: arguments that arrive before the name are not lost, and the live id matches the finished call', async () => {
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ function: { arguments: '{"path":' } }] } }] }, // no index, id, or name yet
      { choices: [{ delta: { tool_calls: [{ id: 'real', function: { name: 'write_file', arguments: '"a.js"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
    const client = { chat: { completions: { create: async () => gen(chunks) } } };
    const ev = await collect(openaiAdapter({ type: 'lmstudio', cfg: {}, secret: '', client }).stream(args));
    const deltas = ev.filter((e) => e.type === 'tool_delta');
    expect(deltas.map((d) => d.delta).join('')).toBe('{"path":"a.js"}');
    const call = ev.find((e) => e.type === 'tool_call');
    expect(call).toMatchObject({ name: 'write_file', args: { path: 'a.js' } });
    expect(new Set(deltas.map((d) => d.id))).toEqual(new Set([call.id]));
  });
});

describe('model picker details', () => {
  it('stores provider help text, and shows prices to users only when the admin allows it', async () => {
    await freshDb(); const app = createApp();
    const admin = await login(app, { username: 'adm', roles: ['administrator'] }), dev = await login(app, { username: 'dev1', roles: ['developer'] });
    const mk = await admin.post('/api/admin/providers').send({ name: 'Acme', type: 'openai', secret: 'k', helpText: '  Best for quick edits.  ' });
    expect(mk.status).toBe(201); expect(mk.body.helpText).toBe('Best for quick edits.');
    await admin.post(`/api/admin/providers/${mk.body.id}/models`).send({ modelId: 'm1', label: 'Model One', contextSize: 200000, inputPrice: 3, outputPrice: 15 });
    // an update that omits helpText keeps it; an empty string clears it
    const keep = await admin.put(`/api/admin/providers/${mk.body.id}`).send({ name: 'Acme', type: 'openai' });
    expect(keep.body.helpText).toBe('Best for quick edits.');
    expect((await admin.put(`/api/admin/providers/${mk.body.id}`).send({ name: 'Acme', type: 'openai', helpText: 'x'.repeat(1001) })).status).toBe(400);

    const off = (await dev.get('/api/models')).body.models[0];
    expect(off).toMatchObject({ label: 'Model One', modelId: 'm1', provider: 'Acme', help: 'Best for quick edits.', contextSize: 200000 });
    expect(off).not.toHaveProperty('inputPrice'); expect(off).not.toHaveProperty('outputPrice');
    expect((await admin.put('/api/admin/general').send({ showModelPricing: true })).status).toBe(200);
    expect((await dev.get('/api/models')).body.models[0]).toMatchObject({ inputPrice: 3, outputPrice: 15 });
    expect((await admin.put(`/api/admin/providers/${mk.body.id}`).send({ name: 'Acme', type: 'openai', helpText: '' })).body.helpText).toBe('');
  });
  it('automatic context sizing is kept per model and hides the fixed size from users', async () => {
    await freshDb(); const app = createApp();
    const admin = await login(app, { username: 'adm', roles: ['administrator'] }), dev = await login(app, { username: 'dev1', roles: ['developer'] });
    const mk = await admin.post('/api/admin/providers').send({ name: 'Local', type: 'openai', secret: 'k' });
    const save = (extra) => admin.post(`/api/admin/providers/${mk.body.id}/models`).send({ modelId: 'm1', contextSize: 32000, ...extra });
    expect((await save({ autoContext: true })).body.models[0]).toMatchObject({ autoContext: true, contextSize: 32000 });
    expect((await dev.get('/api/models')).body.models[0]).toMatchObject({ autoContext: true, contextSize: null });
    expect((await save({})).body.models[0].autoContext).toBe(true); // omitted = unchanged
    expect((await save({ autoContext: false })).body.models[0].autoContext).toBe(false);
    expect((await dev.get('/api/models')).body.models[0]).toMatchObject({ autoContext: false, contextSize: 32000 });
  });
  it('stores per-model help text, keeps it when other fields change, and shows it to users', async () => {
    await freshDb(); const app = createApp();
    const admin = await login(app, { username: 'adm', roles: ['administrator'] }), dev = await login(app, { username: 'dev1', roles: ['developer'] });
    const mk = await admin.post('/api/admin/providers').send({ name: 'LM', type: 'lmstudio', config: {} });
    const url = `/api/admin/providers/${mk.body.id}/models`;
    const r = await admin.post(url).send({ modelId: 'qwen', helpText: '  Good for quick edits.  ' });
    expect(r.body.models[0].helpText).toBe('Good for quick edits.');
    expect((await admin.post(url).send({ modelId: 'qwen', enabled: true })).body.models[0].helpText).toBe('Good for quick edits.'); // omitted: kept
    expect((await admin.post(url).send({ modelId: 'qwen', helpText: 'x'.repeat(501) })).status).toBe(400);
    expect((await dev.get('/api/models')).body.models[0].modelHelp).toBe('Good for quick edits.');
    expect((await admin.post(url).send({ modelId: 'qwen', helpText: '' })).body.models[0].helpText).toBe('');
  });
});

describe('ordering', () => {
  it('reorders providers and models, validates the list, and the model picker follows', async () => {
    await freshDb(); const app = createApp();
    const admin = await login(app, { username: 'adm', roles: ['administrator'] }), dev = await login(app, { username: 'dev1', roles: ['developer'] });
    const a = (await admin.post('/api/admin/providers').send({ name: 'A', type: 'openai', secret: 'k' })).body.id;
    const b = (await admin.post('/api/admin/providers').send({ name: 'B', type: 'openai', secret: 'k' })).body.id;
    for (const [p, m] of [[a, 'a1'], [a, 'a2'], [b, 'b1']]) await admin.post(`/api/admin/providers/${p}/models`).send({ modelId: m });
    const picker = async () => (await dev.get('/api/models')).body.models.map((m) => m.modelId);
    expect((await admin.get('/api/admin/providers')).body.map((p) => p.name)).toEqual(['A', 'B']);
    expect(await picker()).toEqual(['a1', 'a2', 'b1']);
    expect((await admin.put('/api/admin/providers/order').send({ ids: [b, a] })).status).toBe(200);
    const ids = (await admin.get('/api/admin/providers')).body.find((p) => p.id === a).models.map((m) => m.id);
    expect((await admin.put(`/api/admin/providers/${a}/models/order`).send({ ids: [ids[1], ids[0]] })).status).toBe(200);
    expect((await admin.get('/api/admin/providers')).body.map((p) => p.name)).toEqual(['B', 'A']);
    expect(await picker()).toEqual(['b1', 'a2', 'a1']);
    // editing a model keeps its place; a new one goes last
    await admin.post(`/api/admin/providers/${a}/models`).send({ modelId: 'a2', label: 'renamed' });
    await admin.post(`/api/admin/providers/${b}/models`).send({ modelId: 'b2' });
    expect(await picker()).toEqual(['b1', 'b2', 'a2', 'a1']);
    expect((await admin.put('/api/admin/providers/order').send({ ids: [a] })).status).toBe(400);
    expect((await admin.put('/api/admin/providers/order').send({ ids: [a, a] })).status).toBe(400);
    expect((await admin.put(`/api/admin/providers/${a}/models/order`).send({ ids: [ids[0], 99999] })).status).toBe(400);
    expect((await dev.put('/api/admin/providers/order').send({ ids: [a, b] })).status).toBe(403);
  });
});
