import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, createApp, login, addProvider, fakeAdapterFactory, tmpDir } from './helpers.js';
import { getDb } from '../src/db/index.js';
import { config } from '../src/config.js';
import { parseResult, resultText } from '../src/mcp/client.js';
import { saveGenerated, getOwned, hydrator } from '../src/attachments.js';
import { executeTool } from '../src/agent/tools.js';
import { buildRequest as anthropicReq } from '../src/llm/anthropic.js';
import { buildRequest as openaiReq } from '../src/llm/openai.js';
import { buildRequest as bedrockReq } from '../src/llm/bedrock.js';
import { buildRequest as vertexReq, vertexAdapter } from '../src/llm/vertex.js';
import { openaiAdapter } from '../src/llm/openai.js';
import { createAdapter } from '../src/llm/provider.js';
import { isGeminiImageModel } from '../src/llm/vertex.js';
import { encrypt } from '../src/crypto.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(16)]);
const publicLookup = async () => [{ address: '93.184.216.34' }];
const IMG_TOOL = { name: 'render', description: 'Render a picture', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } };

describe('MCP result parsing', () => {
  const r = { content: [{ type: 'text', text: 'here' }, { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }, { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' }] };

  it('pulls images and audio out of the text', () => {
    const p = parseResult(r);
    expect(p.text).toBe('here');
    expect(p.textWithPlaceholders).toBe('here\n[image content omitted]\n[audio content omitted]');
    expect(p.media.map((m) => [m.kind, m.mime])).toEqual([['image', 'image/png'], ['audio', 'audio/wav']]);
    expect(p.media[0].data.equals(PNG)).toBe(true);
  });

  it('resultText keeps its old text-only behaviour', () => {
    expect(resultText(r)).toBe('here\n[image content omitted]\n[audio content omitted]');
    expect(resultText({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] })).toBe('[image content omitted]');
    expect(resultText({ content: [], structuredContent: { a: 1 } })).toBe('{"a":1}');
    expect(resultText({ isError: true, content: [{ type: 'text', text: 'boom' }] })).toBe('Error: boom');
  });
});

describe('stored tool media', () => {
  let user, conv;
  beforeEach(() => {
    freshDb();
    const db = getDb();
    user = Number(db.prepare("INSERT INTO users (source, username) VALUES ('local', 'mia')").run().lastInsertRowid);
    conv = Number(db.prepare("INSERT INTO conversations (user_id, kind, title) VALUES (?, 'agent', 't')").run(user).lastInsertRowid);
  });

  it('saveGenerated sniffs the bytes, names the file, binds it to the conversation and enforces the size cap', async () => {
    const a = await saveGenerated(user, conv, 'render-1', PNG, { maxBytes: 1000 });
    expect(a).toMatchObject({ kind: 'image', mime: 'image/png', name: 'render-1.png' });
    expect(getDb().prepare('SELECT conversation_id c FROM attachments WHERE id=?').get(a.id).c).toBe(conv);
    expect(await saveGenerated(user, conv, 'clip', WAV, { maxBytes: 1000 })).toMatchObject({ kind: 'audio', name: 'clip.wav' });
    expect(await saveGenerated(user, conv, 'x', PNG, { maxBytes: 10 })).toBeNull();                        // too large
    expect(await saveGenerated(user, conv, 'x', Buffer.from('plain text'), { maxBytes: 1000 })).toBeNull(); // not media
    expect(await saveGenerated(user, conv, 'x', Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0]), { maxBytes: 1000 })).toBeNull();
  });

  it('only the owner can read a file back', async () => {
    const a = await saveGenerated(user, conv, 'p', PNG, { maxBytes: 1000 });
    expect(await getOwned(user, a.id)).toMatchObject({ id: a.id, kind: 'image' });
    expect(await getOwned(user + 1, a.id)).toBeNull();
    expect(await getOwned(user, '../../etc/passwd')).toBeNull();
  });

  it('the hydrator loads images for tool messages and skips audio', async () => {
    const img = await saveGenerated(user, conv, 'p', PNG, { maxBytes: 1000 }), snd = await saveGenerated(user, conv, 'c', WAV, { maxBytes: 1000 });
    const [m] = hydrator(user)([{ role: 'tool', toolCallId: 'c1', name: 't', content: 'ok', attachments: [img, snd] }]);
    expect(m.files).toHaveLength(1); expect(m.files[0]).toMatchObject({ kind: 'image', mime: 'image/png' });
  });
});

describe('MCP tool calls that return media', () => {
  let user, conv, root;
  const mcpOut = (text = 'drawn') => ({ text, textWithPlaceholders: `${text}\n[image content omitted]`, media: [{ kind: 'image', mime: 'image/png', data: PNG }] });
  const ctx = (over = {}) => ({
    root, projectId: 1, userId: user, execMode: 'files_only', agentMode: 'act', permissions: new Set(['agent.act', 'mcp.use']), secretGlobs: [], shell: { timeoutSec: 5, outputCap: 1000 },
    mcp: { defs: new Map([['mcp__d__render', { name: 'mcp__d__render', server: 'd', tool: 'render', mcp: true, mutating: false, parameters: { type: 'object', properties: {} } }]]), call: async () => mcpOut() },
    attachments: {
      save: (m, name) => saveGenerated(user, conv, name, m.data, { maxBytes: 1_000_000 }),
      read: async (id) => { const a = await getOwned(user, id); return a ? { name: a.name, mime: a.mime, kind: a.kind, data: fs.readFileSync(path.join(config.dataDir, 'attachments', String(user), id)) } : null; },
    },
    ...over,
  });
  beforeEach(() => {
    freshDb(); root = tmpDir('proj-');
    const db = getDb();
    user = Number(db.prepare("INSERT INTO users (source, username) VALUES ('local', 'mia')").run().lastInsertRowid);
    conv = Number(db.prepare("INSERT INTO conversations (user_id, kind, title) VALUES (?, 'agent', 't')").run(user).lastInsertRowid);
  });

  it('keeps the image as an attachment and names it in the result', async () => {
    const made = [];
    const out = await executeTool('mcp__d__render', {}, ctx(), { callId: 'c1', attachments: made });
    expect(made).toHaveLength(1); expect(made[0]).toMatchObject({ kind: 'image', name: 'render-1.png' });
    expect(out).toBe(`drawn\n[image returned: attachment ${made[0].id}, render-1.png]`);
  });

  it('falls back to the placeholder when this model takes no images', async () => {
    const made = [];
    const out = await executeTool('mcp__d__render', {}, ctx({ attachments: { read: () => null } }), { callId: 'c1', attachments: made });
    expect(made).toHaveLength(0); expect(out).toBe('drawn\n[image content omitted]');
  });

  it('save_attachment writes the bytes into the project, and refuses to overwrite or escape', async () => {
    const made = [];
    await executeTool('mcp__d__render', {}, ctx(), { callId: 'c1', attachments: made });
    const c = ctx();
    expect(await executeTool('save_attachment', { attachment_id: made[0].id, path: 'assets/pic.png' }, c)).toMatch(/Saved render-1\.png to assets\/pic\.png/);
    expect(fs.readFileSync(path.join(root, 'assets/pic.png')).equals(PNG)).toBe(true);
    expect(await executeTool('save_attachment', { attachment_id: made[0].id, path: 'assets/pic.png' }, c)).toMatch(/already exists/);
    expect(await executeTool('save_attachment', { attachment_id: made[0].id, path: 'assets/pic.png', overwrite: true }, c)).toMatch(/Saved/);
    expect(await executeTool('save_attachment', { attachment_id: made[0].id, path: '../out.png' }, c)).toMatch(/escapes the project/);
    expect(fs.existsSync(path.join(root, '..', 'out.png'))).toBe(false);
    expect(await executeTool('save_attachment', { attachment_id: 'f'.repeat(32), path: 'x.png' }, c)).toMatch(/no such attachment/);
    await expect(executeTool('save_attachment', { attachment_id: made[0].id, path: 'x.png' }, ctx({ agentMode: 'plan' }))).rejects.toThrow(); // Act mode only
  });
});

describe('adapters send tool-result images', () => {
  const img = { name: 'p.png', mime: 'image/png', kind: 'image', data: PNG };
  const history = [
    { role: 'user', content: 'draw' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 't', args: {} }, { id: 'c2', name: 't', args: {} }] },
    { role: 'tool', toolCallId: 'c1', name: 't', content: 'one', files: [img] },
    { role: 'tool', toolCallId: 'c2', name: 't', content: 'two' },
  ];
  const a = { system: 'S', messages: history, tools: [], model: 'm', maxTokens: 10 };

  it('Anthropic: image blocks inside the tool_result', () => {
    const [, , u] = anthropicReq(a).messages;
    expect(u.content[0].content).toEqual([{ type: 'text', text: 'one' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }]);
    expect(u.content[1].content).toBe('two');
  });

  it('Bedrock: image block inside the toolResult', () => {
    const [, , u] = bedrockReq(a).messages;
    expect(u.content[0].toolResult.content).toEqual([{ text: 'one' }, { image: { format: 'png', source: { bytes: PNG } } }]);
  });

  it('OpenAI-compatible: images follow the whole run of tool messages in one user message', () => {
    const m = openaiReq(a).messages;
    expect(m.map((x) => x.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'user']);
    expect(m[5].content[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } });
  });

  it('Vertex: images follow the function responses as their own user turn', () => {
    const c = vertexReq(a).contents;
    expect(c.map((x) => x.role)).toEqual(['user', 'model', 'user', 'user']);
    expect(c[2].parts).toHaveLength(2); expect(c[2].parts.every((p) => p.functionResponse)).toBe(true);
    expect(c[3].parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } });
  });

  it('messages without tool images are unchanged', () => {
    const plain = { ...a, messages: history.map(({ files, ...m }) => m) };
    expect(openaiReq(plain).messages.map((x) => x.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool']);
    expect(anthropicReq(plain).messages[2].content[0].content).toBe('one');
  });
});

describe('end to end: an MCP server returns an image', () => {
  let app, dev, admin, proj, modelId, seen, script;
  const fetchImpl = async (url, init) => {
    if (init.method === 'DELETE') return new Response(null, { status: 200 });
    const m = JSON.parse(init.body);
    if (m.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '1' }, capabilities: { tools: {} } }
      : m.method === 'tools/list' ? { tools: [IMG_TOOL] } : { content: [{ type: 'text', text: 'a chart' }, { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 's' } });
  };
  async function turn(body) {
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const res = await fetch(`http://localhost:${server.address().port}/api/agent/turn`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: dev.cookie, 'x-csrf-token': dev.csrf }, body: JSON.stringify(body) });
    const events = []; let buf = '';
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString(); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); }
    }
    server.close();
    return { status: res.status, events };
  }
  beforeEach(async () => {
    freshDb(); modelId = addProvider(); seen = []; script = [];
    app = createApp({ deps: { adapterFactory: fakeAdapterFactory(script, seen), mcp: { fetchImpl, lookup: publicLookup } } });
    dev = login(app, { username: 'devone' });
    admin = login(app, { username: 'adminone', roles: ['administrator'] });
    proj = (await dev.post('/api/projects').send({ name: 'p1' })).body;
    await admin.post('/api/admin/mcp-servers').send({ name: 'd', url: 'https://mcp.example.com/mcp' });
  });

  it('with image support: stored, sent to the model, shown in the UI, readable only by its owner; history keeps no bytes', async () => {
    getDb().prepare('UPDATE models SET image_uploads=1').run();
    script.push([{ type: 'tool_call', id: 'c1', name: 'mcp__d__render', args: {} }], [{ type: 'text', text: 'nice' }]);
    const r = await turn({ projectId: proj.id, message: 'chart it', mode: 'plan', modelId });
    expect(r.status).toBe(200);
    const res = r.events.find((e) => e.type === 'tool_result');
    expect(res.attachments).toHaveLength(1); expect(res.attachments[0]).toMatchObject({ kind: 'image', mime: 'image/png' });
    const id = res.attachments[0].id;
    expect(res.result).toBe(`a chart\n[image returned: attachment ${id}, render-1.png]`);
    // the second request to the model carries the bytes on the tool message
    const toolMsg = seen[1].messages.find((m) => m.role === 'tool');
    expect(toolMsg.files).toHaveLength(1); expect(Buffer.from(toolMsg.files[0].data).equals(PNG)).toBe(true);
    // persisted history holds a reference only
    const stored = getDb().prepare("SELECT content FROM messages WHERE role='tool'").get().content;
    expect(JSON.parse(stored).attachments[0].id).toBe(id); expect(stored).not.toContain('files'); expect(stored.length).toBeLessThan(1000);
    // the session timeline carries it for the UI
    const cid = r.events.find((e) => e.type === 'start').conversationId;
    const item = (await dev.get(`/api/sessions/${cid}`)).body.items.find((i) => i.kind === 'tool');
    expect(item.attachments).toEqual([{ id, name: 'render-1.png', kind: 'image' }]);
    // GET serves it inline, sandboxed, to its owner only
    const got = await dev.get(`/api/attachments/${id}`).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(got.status).toBe(200); expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff'); expect(got.headers['content-security-policy']).toBe('sandbox');
    expect(got.headers['content-disposition']).toMatch(/^inline/); expect(got.body.equals(PNG)).toBe(true);
    expect((await login(app, { username: 'devtwo' }).get(`/api/attachments/${id}`)).status).toBe(404);
    expect((await dev.get(`/api/attachments/${'0'.repeat(32)}`)).status).toBe(404);
    expect((await dev.get('/api/attachments/not-an-id')).status).toBe(404);
    // deleting the conversation removes the file
    const file = path.join(config.dataDir, 'attachments', String(dev.id), id);
    expect(fs.existsSync(file)).toBe(true);
    await dev.del(`/api/sessions/${cid}`);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('without image support the image is left out, as before', async () => {
    script.push([{ type: 'tool_call', id: 'c1', name: 'mcp__d__render', args: {} }], [{ type: 'text', text: 'ok' }]);
    const r = await turn({ projectId: proj.id, message: 'chart it', mode: 'plan', modelId });
    const res = r.events.find((e) => e.type === 'tool_result');
    expect(res.result).toBe('a chart\n[image content omitted]'); expect(res.attachments).toBeUndefined();
    expect(getDb().prepare('SELECT COUNT(*) c FROM attachments').get().c).toBe(0);
  });
});

describe('images the model itself generates (Gemini image output)', () => {
  async function* gen(items) { for (const i of items) yield i; }
  const collect = async (it) => { const out = []; for await (const e of it) out.push(e); return out; };
  const b64 = PNG.toString('base64');

  it('Vertex: inlineData parts become media events; thoughts are not images', async () => {
    const chunks = [{ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' }, thought: true }, { text: 'Here you go' }, { inlineData: { mimeType: 'image/png', data: b64 } }] }, finishReason: 'STOP' }] }];
    const client = { models: { generateContentStream: async () => gen(chunks) } };
    const ev = await collect(vertexAdapter({ cfg: { project: 'p' }, secret: '', client }).stream({ system: 's', messages: [], tools: [], model: 'gemini-2.5-flash-image', maxTokens: 10 }));
    const media = ev.filter((e) => e.type === 'media');
    expect(media).toHaveLength(1); expect(media[0].mime).toBe('image/png'); expect(media[0].data.equals(PNG)).toBe(true);
    expect(ev.find((e) => e.type === 'text').text).toBe('Here you go');
  });

  it('OpenAI-compatible gateways: delta.images data URLs become media events; other URLs are ignored', async () => {
    const chunks = [{ choices: [{ delta: { content: 'ok', images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }, { type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }, finish_reason: 'stop' }] }];
    const client = { chat: { completions: { create: async () => gen(chunks) } } };
    const ev = await collect(openaiAdapter({ type: 'generic', cfg: {}, secret: 'k', client }).stream({ system: 's', messages: [], tools: [], model: 'm', maxTokens: 10 }));
    const media = ev.filter((e) => e.type === 'media');
    expect(media).toHaveLength(1); expect(media[0].data.equals(PNG)).toBe(true);
  });

  describe('Gemini API key (type "gemini")', () => {
    const provider = { type: 'gemini', config: '{}', secret_enc: encrypt('k') };
    const tool = { name: 'read_file', description: 'r', parameters: { type: 'object', properties: {} } };
    const opts = (model) => ({ system: 'S', messages: [{ role: 'user', content: 'draw a banana' }], tools: [tool], model, maxTokens: 50, thinking: { mode: 'adaptive' } });

    it('recognises image models, not other Gemini models', () => {
      for (const id of ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'models/gemini-2.5-flash-image-preview', 'gemini-nano-banana-2.1', 'nano-banana-pro-preview']) expect(isGeminiImageModel(id)).toBe(true);
      for (const id of ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.8-flash-cyber', 'gemini-4-argon', 'imagen-4.0-generate-001', 'gpt-image-1']) expect(isGeminiImageModel(id)).toBe(false);
    });

    it('an image model goes to the native API (text + image output, no tools or thinking) and its picture comes back as media', async () => {
      let req;
      const nativeClient = { models: { generateContentStream: async (r) => { req = r; return gen([{ candidates: [{ content: { parts: [{ text: 'Here' }, { inlineData: { mimeType: 'image/jpeg', data: b64 } }] }, finishReason: 'STOP' }] }]); } } };
      let compatCalled = false;
      const client = { chat: { completions: { create: async () => { compatCalled = true; return gen([]); } } } };
      const ev = await collect(createAdapter(provider, { client, nativeClient }).stream(opts('gemini-2.5-flash-image')));
      expect(compatCalled).toBe(false);
      expect(req.model).toBe('gemini-2.5-flash-image');
      expect(req.config.responseModalities).toEqual(['TEXT', 'IMAGE']);
      expect(req.config.tools).toBeUndefined(); expect(req.config.thinkingConfig).toBeUndefined();
      expect(ev.find((e) => e.type === 'media')).toMatchObject({ mime: 'image/jpeg' });
      expect(ev.at(-1)).toMatchObject({ type: 'done' });
    });

    it('an image model that returns nothing fails with the reason instead of an empty reply', async () => {
      const mk = (chunks) => ({ models: { generateContentStream: async () => gen(chunks) } });
      const run = (chunks) => collect(createAdapter(provider, { nativeClient: mk(chunks) }).stream(opts('gemini-2.5-flash-image')));
      await expect(run([{ candidates: [{ content: { parts: [] }, finishReason: 'IMAGE_SAFETY', finishMessage: 'Blocked' }] }])).rejects.toThrow(/no image or text \(finish reason IMAGE_SAFETY: Blocked\)/);
      await expect(run([{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }])).rejects.toThrow(/prompt was blocked: PROHIBITED_CONTENT/);
      await expect(run([{ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }] }, finishReason: 'STOP' }] }])).rejects.toThrow(/no image or text/);
      expect((await run([{ candidates: [{ content: { parts: [{ text: 'just words' }] }, finishReason: 'STOP' }] }])).some((e) => e.type === 'text')).toBe(true);   // text alone is fine
    });

    it('other Gemini models stay on the OpenAI-compatible endpoint', async () => {
      let nativeCalled = false;
      const nativeClient = { models: { generateContentStream: async () => { nativeCalled = true; return gen([]); } } };
      const client = { chat: { completions: { create: async () => gen([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }]) } } };
      const ev = await collect(createAdapter(provider, { client, nativeClient }).stream(opts('gemini-2.5-pro')));
      expect(nativeCalled).toBe(false); expect(ev.find((e) => e.type === 'text').text).toBe('hi');
    });
  });

  describe('through the app', () => {
    let app, dev, proj, modelId, seen, script;
    async function turn(body, url = '/api/agent/turn') {
      const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
      const res = await fetch(`http://localhost:${server.address().port}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: dev.cookie, 'x-csrf-token': dev.csrf }, body: JSON.stringify(body) });
      const events = []; let buf = '';
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString(); let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); }
      }
      server.close();
      return { status: res.status, events };
    }
    const bytes = async (r) => r.buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    beforeEach(async () => {
      freshDb(); modelId = addProvider(); seen = []; script = [];
      app = createApp({ deps: { adapterFactory: fakeAdapterFactory(script, seen) } });
      dev = login(app, { username: 'devone' });
      proj = (await dev.post('/api/projects').send({ name: 'p1' })).body;
    });

    it('agent: the image is stored, announced, kept in history and the timeline, downloadable, and not sent back to the model', async () => {
      script.push([{ type: 'media', mime: 'image/png', data: PNG }, { type: 'text', text: 'Here is your banana' }]);       // no image-input support is needed to see output
      const r = await turn({ projectId: proj.id, message: 'draw a banana', mode: 'plan', modelId });
      const ev = r.events.find((e) => e.type === 'media');
      expect(ev.attachments).toHaveLength(1); expect(ev.attachments[0]).toMatchObject({ kind: 'image', mime: 'image/png', name: 'generated-1.png' });
      const id = ev.attachments[0].id;
      const stored = JSON.parse(getDb().prepare("SELECT content FROM messages WHERE role='assistant'").get().content);
      expect(stored.attachments[0].id).toBe(id); expect(stored.content).toBe('Here is your banana');
      const cid = r.events.find((e) => e.type === 'start').conversationId;
      const items = (await dev.get(`/api/sessions/${cid}`)).body.items;
      expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'media']);
      expect(items[2].attachments).toEqual([{ id, name: 'generated-1.png', kind: 'image' }]);
      expect((await bytes(dev.get(`/api/attachments/${id}`))).headers['content-disposition']).toMatch(/^inline/);
      const dl = await bytes(dev.get(`/api/attachments/${id}?download=1`));
      expect(dl.headers['content-disposition']).toMatch(/^attachment; filename\*=UTF-8''generated-1\.png/); expect(dl.body.equals(PNG)).toBe(true);
      // a follow-up does not send the model its own image back
      script.push([{ type: 'text', text: 'ok' }]);
      await turn({ projectId: proj.id, message: 'thanks', mode: 'plan', modelId, conversationId: cid });
      expect(seen[1].messages.some((m) => m.files?.length)).toBe(false);
    });

    it('chat: the image arrives, and reloads from history with its id', async () => {
      script.push([{ type: 'media', mime: 'image/png', data: PNG }, { type: 'text', text: 'done' }]);
      const r = await turn({ message: 'draw', modelId, chatType: 'general' }, '/api/chat/turn');
      expect(r.status).toBe(200);
      const ev = r.events.find((e) => e.type === 'media'); expect(ev.attachments[0]).toMatchObject({ kind: 'image' });
      const cid = r.events.find((e) => e.type === 'start').conversationId;
      const msgs = (await dev.get(`/api/conversations/${cid}/messages`)).body;
      expect(msgs.find((m) => m.role === 'assistant').attachments).toEqual([{ id: ev.attachments[0].id, name: 'generated-1.png', kind: 'image' }]);
    });

    it('chat: the reason an image model returned nothing is shown; any other model error stays generic', async () => {
      const failing = (err) => () => ({ async listModels() { return []; }, async *stream() { throw err; } });
      const shown = Object.assign(new Error('Gemini returned no image or text (finish reason IMAGE_SAFETY).'), { userMessage: true });
      for (const [err, want] of [[shown, 'Gemini returned no image or text (finish reason IMAGE_SAFETY).'], [new Error('400 secret upstream detail'), 'The model request failed.']]) {
        app = createApp({ deps: { adapterFactory: failing(err) } });
        dev = login(app, { username: `u${Math.random().toString(36).slice(2, 8)}` });
        const r = await turn({ message: 'draw', modelId, chatType: 'general' }, '/api/chat/turn');
        expect(r.events.find((e) => e.type === 'error').message).toBe(want);
      }
    });

    it('output that is not a viewable image is dropped with a notice', async () => {
      script.push([{ type: 'media', mime: 'image/png', data: Buffer.from('not an image') }, { type: 'text', text: 'hm' }]);
      const r = await turn({ projectId: proj.id, message: 'draw', mode: 'plan', modelId });
      expect(r.events.some((e) => e.type === 'media')).toBe(false);
      expect(r.events.find((e) => e.type === 'notice').text).toMatch(/could not be shown/);
      expect(getDb().prepare('SELECT COUNT(*) c FROM attachments').get().c).toBe(0);
    });
  });
});
