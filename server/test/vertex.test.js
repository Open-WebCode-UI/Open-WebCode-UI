import { describe, it, expect } from 'vitest';
import { vertexAdapter, buildRequest } from '../src/llm/vertex.js';
import { defaultThinking } from '../src/llm/thinking.js';

const collect = async (it) => { const o = []; for await (const e of it) o.push(e); return o; };
const tool = { name: 'read_file', description: 'd', parameters: { type: 'object', properties: { path: { type: 'string' } } } };

describe('vertex buildRequest', () => {
  it('maps messages, files, tools, and thought signatures to Gemini contents', () => {
    const r = buildRequest({
      system: 'sys', model: 'gemini-2.5-pro', maxTokens: 100, temperature: 0.2, tools: [tool], toolChoice: { name: 'read_file' },
      messages: [
        { role: 'user', content: 'hi', files: [{ kind: 'pdf', mime: 'application/pdf', name: 'a.pdf', data: Buffer.from('x') }] },
        { role: 'assistant', content: 'ok', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a' } }, { id: 'c2', name: 'read_file', args: { path: 'b' } }], thinkingBlocks: [{ model: 'gemini-2.5-pro', block: { callId: 'c1', signature: 'SIG' } }, { model: 'other', block: { callId: 'c2', signature: 'NO' } }] },
        { role: 'tool', toolCallId: 'c1', name: 'read_file', content: 'A' }, { role: 'tool', toolCallId: 'c2', name: 'read_file', content: 'B' },
      ],
    });
    expect(r.contents[0].parts[0].inlineData.mimeType).toBe('application/pdf');
    expect(r.contents[1]).toEqual({ role: 'model', parts: [{ text: 'ok' }, { functionCall: { name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'SIG' }, { functionCall: { name: 'read_file', args: { path: 'b' } } }] });
    expect(r.contents[2].parts.map((p) => p.functionResponse.response.output)).toEqual(['A', 'B']);
    expect(r.config).toMatchObject({ systemInstruction: 'sys', maxOutputTokens: 100, temperature: 0.2, toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read_file'] } } });
    expect(r.config.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(tool.parameters);
  });
  it('configures thinking', () => {
    const base = { system: 's', messages: [], model: 'm', maxTokens: 100 };
    expect(buildRequest({ ...base, thinking: { mode: 'adaptive' } }).config.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: -1 });
    const b = buildRequest({ ...base, thinking: { mode: 'budget', budget: 2000 } }).config;
    expect(b.thinkingConfig.thinkingBudget).toBe(2000); expect(b.maxOutputTokens).toBe(3024);
    expect(buildRequest(base).config.thinkingConfig).toBeUndefined();
  });
});

describe('vertex adapter', () => {
  async function* gen(chunks) { for (const c of chunks) yield c; }
  it('streams thoughts, text, and function calls, with usage', async () => {
    const chunks = [
      { candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: 'hello' }, { functionCall: { name: 'read_file', args: { path: 'z' } }, thoughtSignature: 'S' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 2 } },
    ];
    const client = { models: { generateContentStream: async () => gen(chunks) } };
    const ev = await collect(vertexAdapter({ cfg: { project: 'p' }, secret: '', client }).stream({ system: 's', messages: [], tools: [tool], model: 'gemini-2.5-pro', maxTokens: 10 }));
    expect(ev).toEqual([
      { type: 'thinking', text: 'hmm' }, { type: 'text', text: 'hello' },
      { type: 'tool_delta', id: 'call_0', name: 'read_file', delta: '{"path":"z"}' },
      { type: 'thinking_block', model: 'gemini-2.5-pro', block: { callId: 'call_0', signature: 'S' } },
      { type: 'tool_call', id: 'call_0', name: 'read_file', args: { path: 'z' } },
      { type: 'usage', inputTokens: 5, outputTokens: 5 }, { type: 'done', stop: 'tool_use' }]);
  });
  it('lists models without the publisher prefix', async () => {
    const client = { models: { list: async () => gen([{ name: 'publishers/google/models/gemini-2.5-pro' }, { name: 'publishers/google/models/gemini-2.5-flash' }]) } };
    expect(await vertexAdapter({ cfg: { project: 'p' }, secret: '', client }).listModels()).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
  });
  it('rejects a secret that is not JSON, and defaults Gemini 2.5+ to adaptive thinking', async () => {
    await expect(vertexAdapter({ cfg: { project: 'p' }, secret: 'not json' }).listModels()).rejects.toThrow(/JSON/);
    expect(defaultThinking('vertex', 'gemini-2.5-pro').mode).toBe('adaptive');
    expect(defaultThinking('vertex', 'gemini-1.5-pro').mode).toBe('off');
  });
});
