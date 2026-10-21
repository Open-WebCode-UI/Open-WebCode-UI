import { GoogleGenAI } from '@google/genai';
import { replayable } from './thinking.js';

// Google Vertex AI through the native Gemini API (generateContent), not the OpenAI-compatible endpoint.
// Gemini 3 needs the thought signature of a function call echoed back with it, so each signature is kept as a thinking block keyed by call id.
const fnCall = (c, sig) => ({ functionCall: { name: c.name, args: c.args }, ...(sig ? { thoughtSignature: sig } : {}) });

// Gemini image models (Nano Banana: ids such as gemini-2.5-flash-image or gemini-nano-banana-2.1) draw pictures, which Google's OpenAI-compatible endpoint cannot return, so they use the native API.
// They take no tools or thinking settings and are asked for text and image output.
export const isGeminiImageModel = (id) => /^(models\/)?(gemini-[\w.-]*(image|nano-banana)|nano-banana)/i.test(String(id));

export function buildRequest({ system, messages, tools, model, maxTokens, temperature, thinking, toolChoice }, { image = false } = {}) {
  const contents = [];
  // Images a tool returned follow the run of function responses as their own user turn.
  let toolImages = [];
  const flushToolImages = () => {
    if (toolImages.length) contents.push({ role: 'user', parts: [{ text: '(Images returned by the tool calls above.)' }, ...toolImages] });
    toolImages = [];
  };
  for (const m of messages) {
    if (m.role !== 'tool') flushToolImages();
    if (m.role === 'tool') {
      for (const f of m.files || []) if (f.kind === 'image') toolImages.push({ inlineData: { mimeType: f.mime, data: f.data.toString('base64') } });
      const part = { functionResponse: { name: m.name, response: { output: m.content || '(empty)' } } };
      const last = contents[contents.length - 1];
      if (last?.role === 'user' && last.parts[0]?.functionResponse) last.parts.push(part); else contents.push({ role: 'user', parts: [part] });
    } else if (m.role === 'assistant') {
      const sigs = new Map(replayable(m, model).filter((b) => b.callId).map((b) => [b.callId, b.signature]));
      const parts = [...(m.content ? [{ text: m.content }] : []), ...(m.toolCalls || []).map((c) => fnCall(c, sigs.get(c.id)))];
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: ' ' }] });
    } else if (m.role === 'user' && m.files?.length) {
      contents.push({ role: 'user', parts: [...m.files.map((f) => ({ inlineData: { mimeType: f.kind === 'pdf' ? 'application/pdf' : f.mime, data: f.data.toString('base64') } })), { text: m.content || ' ' }] });
    } else contents.push({ role: 'user', parts: [{ text: m.content || ' ' }] });
  }
  flushToolImages();
  const config = { systemInstruction: system, maxOutputTokens: maxTokens };
  if (temperature != null) config.temperature = temperature;
  // adaptive = let the model decide how much to think (-1); budget = a fixed token budget. Thought summaries are requested so they can be shown.
  if (image) config.responseModalities = ['TEXT', 'IMAGE'];
  else if (thinking?.mode === 'adaptive') config.thinkingConfig = { includeThoughts: true, thinkingBudget: -1 };
  else if (thinking?.mode === 'budget') { config.thinkingConfig = { includeThoughts: true, thinkingBudget: thinking.budget }; config.maxOutputTokens = Math.max(maxTokens, thinking.budget + 1024); }
  if (tools?.length && !image) {
    config.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }];
    if (toolChoice?.name) config.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolChoice.name] } };
  }
  return { model, contents, config };
}

// secret = the service-account key JSON, or empty to use Application Default Credentials (e.g. the server's attached service account).
const clientOf = (cfg, secret) => {
  let credentials;
  if (secret) { try { credentials = JSON.parse(secret); } catch { throw new Error('The Vertex secret must be a service-account key in JSON form.'); } }
  return new GoogleGenAI({ vertexai: true, project: cfg.project, location: cfg.location || 'global', googleAuthOptions: { scopes: ['https://www.googleapis.com/auth/cloud-platform'], ...(credentials ? { credentials } : {}) } });
};

async function* streamGenai(client, opts, { image = false } = {}) {
  const { model, contents, config } = buildRequest(opts, { image });
  const stream = await client.models.generateContentStream({ model, contents, config: { ...config, abortSignal: opts.signal } });
  const calls = []; let stop = 'stop', usage = null, produced = false, why = '';
  for await (const chunk of stream) {
    if (process.env.DEBUG_LLM_STREAM) console.error('[llm-stream]', JSON.stringify({ finish: chunk.candidates?.[0]?.finishReason, block: chunk.promptFeedback?.blockReason, parts: (chunk.candidates?.[0]?.content?.parts || []).map((p) => (p.inlineData ? { image: p.inlineData.mimeType, b64: p.inlineData.data?.length, thought: p.thought } : p.functionCall ? { call: p.functionCall.name } : { text: p.text?.length, thought: p.thought })) }));
    if (chunk.promptFeedback?.blockReason) why = `the prompt was blocked: ${chunk.promptFeedback.blockReason}${chunk.promptFeedback.blockReasonMessage ? ` - ${chunk.promptFeedback.blockReasonMessage}` : ''}`;
    if (chunk.usageMetadata) usage = { inputTokens: chunk.usageMetadata.promptTokenCount || 0, outputTokens: (chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0) };
    const cand = chunk.candidates?.[0];
    if (cand?.finishReason && cand.finishReason !== 'STOP' && cand.finishReason !== 'MAX_TOKENS') why = `finish reason ${cand.finishReason}${cand.finishMessage ? `: ${cand.finishMessage}` : ''}`;
    for (const p of cand?.content?.parts || []) {
      if (p.functionCall) {
        const id = p.functionCall.id || `call_${calls.length}`, name = p.functionCall.name, args = p.functionCall.args || {};
        calls.push({ id, name, args }); produced = true;
        yield { type: 'tool_delta', id, name, delta: JSON.stringify(args) };
        if (p.thoughtSignature) yield { type: 'thinking_block', model: opts.model, block: { callId: id, signature: p.thoughtSignature } };
      } else if (p.inlineData?.data && !p.thought) yield (produced = true, { type: 'media', mime: String(p.inlineData.mimeType || ''), data: Buffer.from(p.inlineData.data, 'base64') }); // an image the model drew
      else if (p.text) { if (!p.thought) produced = true; yield { type: p.thought ? 'thinking' : 'text', text: p.text }; }
    }
    if (cand?.finishReason) stop = cand.finishReason === 'MAX_TOKENS' ? 'length' : calls.length ? 'tool_use' : 'stop';
  }
  // An image model that answers with nothing (a safety block, "no image") would otherwise leave an empty message and no explanation.
  if (image && !produced) throw Object.assign(new Error(`Gemini returned no image or text${why ? ` (${why})` : ''}.`), { userMessage: true }); // safe to show: it only names Google's reason
  for (const c of calls) yield { type: 'tool_call', id: c.id, name: c.name, args: c.args };
  if (usage) yield { type: 'usage', ...usage };
  yield { type: 'done', stop };
}

// Gemini API key + a Gemini image model: the native API through the same SDK as Vertex.
export function geminiImageAdapter({ secret, client }) {
  return { stream: (opts) => streamGenai(client || new GoogleGenAI({ apiKey: secret }), opts, { image: true }) };
}

export function vertexAdapter({ cfg, secret, client }) {
  const make = () => client || clientOf(cfg, secret);
  return {
    buildRequest,
    async listModels() {
      const out = [];
      for await (const m of await make().models.list({ config: { pageSize: 100 } })) {
        if (m.name) out.push(m.name.replace(/^publishers\/[^/]+\/models\//, '').replace(/^models\//, ''));
      }
      return [...new Set(out)].sort();
    },
    stream: (opts) => streamGenai(make(), opts),
  };
}
