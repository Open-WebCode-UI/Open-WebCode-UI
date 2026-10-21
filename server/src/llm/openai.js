import { createHash } from 'node:crypto';
import OpenAI, { AzureOpenAI } from 'openai';
import { parseArgs } from './provider.js';
import { ThinkSplitter, replayable } from './thinking.js';

// Covers OpenAI-compatible endpoints, LM Studio, Ollama, generic self-hosted servers, Gemini, Mistral, and Azure OpenAI.
const LOCAL = new Set(['lmstudio', 'ollama', 'generic']);
const MAX_TOKENS = new Set([...LOCAL, 'gemini', 'mistral']); // servers that take max_tokens, not max_completion_tokens
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/'; // Google's OpenAI-compatible Gemini endpoint
const MISTRAL_URL = 'https://api.mistral.ai/v1';
// Mistral only accepts tool-call ids of exactly 9 letters/digits; ids from other providers (or a mid-chat model switch) are mapped to a stable 9-character one.
// Gemini 3 needs each function call's thought signature echoed back (tool_calls[].extra_content.google.thought_signature). History without one
// (another model's turns, or turns saved before this was kept) gets Google's documented placeholder so validation passes.
const GEMINI_SKIP_SIGNATURE = 'skip_thought_signature_validator';
const needsSignature = (model) => /gemini-([3-9]|\d{2})/i.test(String(model));
const mistralId = (id) => (/^[A-Za-z0-9]{9}$/.test(id) ? id : createHash('sha256').update(String(id)).digest('hex').slice(0, 9));
export function buildRequest({ system, messages, tools, model, maxTokens, temperature, toolChoice, thinking }, { type } = {}) {
  const tid = type === 'mistral' ? mistralId : (id) => id;
  const msgs = [{ role: 'system', content: system }];
  // A tool message can only hold text here, so images a tool returned follow the whole run of tool messages as one user message.
  let toolImages = [];
  const flushToolImages = () => {
    if (toolImages.length) msgs.push({ role: 'user', content: [{ type: 'text', text: '(Images returned by the tool calls above.)' }, ...toolImages] });
    toolImages = [];
  };
  for (const m of messages) {
    if (m.role !== 'tool') flushToolImages();
    if (m.role === 'tool') {
      msgs.push({ role: 'tool', tool_call_id: tid(m.toolCallId), content: m.content });
      for (const f of m.files || []) if (f.kind === 'image') toolImages.push({ type: 'image_url', image_url: { url: `data:${f.mime};base64,${f.data.toString('base64')}` } });
    }
    else if (m.role === 'assistant' && m.toolCalls?.length) {
      const sigs = type === 'gemini' && needsSignature(model) ? new Map(replayable(m, model).filter((b) => b.callId).map((b) => [b.callId, b.signature])) : null;
      msgs.push({ role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: tid(c.id), type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) }, ...(sigs ? { extra_content: { google: { thought_signature: sigs.get(c.id) || GEMINI_SKIP_SIGNATURE } } } : {}) })) });
    } else if (m.role === 'user' && m.files?.length) {
      msgs.push({ role: 'user', content: [{ type: 'text', text: m.content }, ...m.files.map((f) => (f.kind === 'pdf'
        ? { type: 'file', file: { filename: f.name, file_data: `data:application/pdf;base64,${f.data.toString('base64')}` } }
        : { type: 'image_url', image_url: { url: `data:${f.mime};base64,${f.data.toString('base64')}` } }))] });
    } else msgs.push({ role: m.role, content: m.content });
  }
  flushToolImages();
  const req = { model, messages: msgs, stream: true, stream_options: { include_usage: true }, max_completion_tokens: maxTokens };
  if (type === 'mistral') delete req.stream_options; // Mistral reports usage on the last chunk by default and may reject the option
  // Gemini thinks silently unless thought summaries are requested, which looks like a stall until the answer starts.
  if (type === 'gemini' && thinking?.mode && thinking.mode !== 'off') req.extra_body = { google: { thinking_config: { include_thoughts: true } } };
  if (temperature != null) req.temperature = temperature;
  if (tools?.length) req.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  if (toolChoice?.name && req.tools && !LOCAL.has(type)) req.tool_choice = { type: 'function', function: { name: toolChoice.name } }; // local servers often reject a named choice
  return req;
}

export function openaiAdapter({ type, cfg, secret, client, fetchImpl = fetch }) {
  const make = () => {
    if (client) return client;
    if (type === 'azure') return new AzureOpenAI({ endpoint: cfg.baseUrl, apiKey: secret, apiVersion: cfg.apiVersion || '2024-10-21', deployment: cfg.deployment });
    return new OpenAI({ baseURL: cfg.baseUrl || (type === 'gemini' ? GEMINI_URL : type === 'mistral' ? MISTRAL_URL : undefined), apiKey: secret || (type === 'lmstudio' ? 'lm-studio' : type === 'ollama' ? 'ollama' : type === 'generic' ? 'none' : '') });
  };
  return {
    buildRequest,
    async listModels() {
      if (type === 'azure' && !client) {
        // Azure routes requests by *deployment name*, so list deployments first; fall back to the base-model catalog.
        try {
          const r = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, '')}/openai/deployments?api-version=${encodeURIComponent(cfg.apiVersion || '2023-03-15-preview')}`, { headers: { 'api-key': secret }, redirect: 'error' });
          if (r.ok) { const j = await r.json(); const ids = (j.data || []).map((d) => d.id).filter(Boolean); if (ids.length) return ids.sort(); }
        } catch { /* fall through */ }
      }
      const out = []; for await (const m of make().models.list()) out.push(type === 'gemini' ? m.id.replace(/^models\//, '') : m.id); return out.sort(); // Gemini lists ids as "models/<name>"
    },
    async *stream(args) {
      const req = buildRequest(args, { type });
      if (MAX_TOKENS.has(type)) { req.max_tokens = req.max_completion_tokens; delete req.max_completion_tokens; }
      const stream = await make().chat.completions.create(req, { signal: args.signal });
      const calls = new Map(), split = new ThinkSplitter(type === 'gemini' ? 'thought' : 'think');
      let stop = 'stop', usage = null;
      for await (const chunk of stream) {
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens || 0, outputTokens: chunk.usage.completion_tokens || 0 };
        const ch = chunk.choices?.[0];
        if (!ch) continue;
        if (process.env.DEBUG_LLM_STREAM) console.error('[llm-stream]', JSON.stringify({ r: ch.delta?.reasoning_content ?? ch.delta?.reasoning, c: ch.delta?.content, t: ch.delta?.tool_calls?.length || undefined, f: ch.finish_reason }));
        // Reasoning arrives as delta.reasoning_content (DeepSeek, vLLM, LM Studio) or delta.reasoning (OpenRouter), or inline as <think>…</think>.
        const reasoning = ch.delta?.reasoning_content || ch.delta?.reasoning;
        if (reasoning) yield { type: 'thinking', text: reasoning };
        if (ch.delta?.content) for (const part of split.feed(ch.delta.content)) yield { type: part.kind, text: part.text };
        for (const im of Array.isArray(ch.delta?.images) ? ch.delta.images : []) {
          const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(im?.image_url?.url || '');
          if (m) yield { type: 'media', mime: m[1], data: Buffer.from(m[2], 'base64') };
        }
        for (const tc of ch.delta?.tool_calls || []) {
          const idx = tc.index ?? 0; // some local servers omit the index when there is a single call
          const c = calls.get(idx) || { id: '', name: '', args: '', sent: 0, sid: '', sig: '' };
          if (tc.id) c.id = tc.id;
          if (tc.extra_content?.google?.thought_signature) c.sig = tc.extra_content.google.thought_signature;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.args += tc.function.arguments;
          calls.set(idx, c);
          // Local servers may send the arguments before the name or the id. Hold the text back until the call can be named, then send everything so far.
          // The id used for the live view is fixed at that point and reused for the finished call, so both refer to the same card.
          if (c.name && c.args.length >= c.sent) {
            c.sid ||= c.id || `call_${idx}`;
            yield { type: 'tool_delta', id: c.sid, name: c.name, delta: c.args.slice(c.sent) };
            c.sent = c.args.length;
          }
        }
        if (ch.finish_reason) stop = ch.finish_reason;
      }
      for (const part of split.flush()) yield { type: part.kind, text: part.text };
      for (const [index, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        const id = c.sid || c.id || `call_${index}`;
        if (c.sig) yield { type: 'thinking_block', model: args.model, block: { callId: id, signature: c.sig } };
        yield { type: 'tool_call', id, name: c.name, args: parseArgs(c.args) };
      }
      if (usage) yield { type: 'usage', ...usage };
      yield { type: 'done', stop };
    },
  };
}
