import Anthropic from '@anthropic-ai/sdk';
import { parseArgs } from './provider.js';
import { replayable } from './thinking.js';

export function buildRequest({ system, messages, tools, model, maxTokens, temperature, thinking, toolChoice }) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const imgs = (m.files || []).filter((f) => f.kind === 'image');
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: imgs.length ? [{ type: 'text', text: m.content || '(empty)' }, ...imgs.map((f) => ({ type: 'image', source: { type: 'base64', media_type: f.mime, data: f.data.toString('base64') } }))] : m.content };
      const last = out[out.length - 1];
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block); else out.push({ role: 'user', content: [block] });
    } else if (m.role === 'assistant' && (m.toolCalls?.length || replayable(m, model).length)) {
      // Thinking blocks go back first, unchanged (signatures included), and only to the model that produced them.
      out.push({ role: 'assistant', content: [...replayable(m, model), ...(m.content ? [{ type: 'text', text: m.content }] : []), ...(m.toolCalls || []).map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args }))] });
    } else if (m.role === 'user' && m.files?.length) {
      out.push({ role: 'user', content: [...m.files.map((f) => (f.kind === 'pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data.toString('base64') }, title: f.name }
        : { type: 'image', source: { type: 'base64', media_type: f.mime, data: f.data.toString('base64') } })), { type: 'text', text: m.content }] });
    } else out.push({ role: m.role, content: m.content });
  }
  const req = { model, system, messages: out, max_tokens: maxTokens, stream: true };
  if (thinking?.mode === 'adaptive') req.thinking = { type: 'adaptive', display: 'summarized' };
  else if (thinking?.mode === 'budget') { req.thinking = { type: 'enabled', budget_tokens: thinking.budget }; req.max_tokens = Math.max(maxTokens, thinking.budget + 1024); }
  if (temperature != null && !req.thinking) req.temperature = temperature; // sampling params are rejected/ignored with thinking on
  if (tools?.length) req.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  // A forced tool is rejected together with extended thinking, so it only applies when thinking is off.
  if (toolChoice?.name && req.tools && !req.thinking) req.tool_choice = { type: 'tool', name: toolChoice.name };
  return req;
}

export function anthropicAdapter({ cfg, secret, client }) {
  const make = () => client || new Anthropic({ apiKey: secret, baseURL: cfg.baseUrl || undefined });
  return {
    buildRequest,
    async listModels() { const out = []; for await (const m of make().models.list()) out.push(m.id); return out.sort(); },
    // true/false when the API reports it, null when it doesn't say.
    async supportsThinking(id) { const t = (await make().models.retrieve(id))?.capabilities?.thinking; return t == null ? null : !!(t.supported ?? t); },
    async *stream(args) {
      const stream = await make().messages.create(buildRequest(args), { signal: args.signal });
      const blocks = new Map(), thoughts = new Map();
      let stop = 'end_turn';
      const usage = { input: 0, output: 0 };
      for await (const ev of stream) {
        if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
          blocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: '' });
          yield { type: 'tool_delta', id: ev.content_block.id, name: ev.content_block.name, delta: '' };
        }
        else if (ev.type === 'content_block_start' && ev.content_block.type === 'thinking') thoughts.set(ev.index, { type: 'thinking', thinking: '', signature: '' });
        else if (ev.type === 'content_block_start' && ev.content_block.type === 'redacted_thinking') thoughts.set(ev.index, { type: 'redacted_thinking', data: ev.content_block.data });
        else if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') yield { type: 'text', text: ev.delta.text };
          else if (ev.delta.type === 'thinking_delta') { thoughts.get(ev.index).thinking += ev.delta.thinking; yield { type: 'thinking', text: ev.delta.thinking }; }
          else if (ev.delta.type === 'signature_delta') thoughts.get(ev.index).signature = ev.delta.signature;
          else if (ev.delta.type === 'input_json_delta') {
            const b = blocks.get(ev.index); b.json += ev.delta.partial_json;
            yield { type: 'tool_delta', id: b.id, name: b.name, delta: ev.delta.partial_json };
          }
        } else if (ev.type === 'content_block_stop' && thoughts.has(ev.index)) {
          yield { type: 'thinking_block', model: args.model, block: thoughts.get(ev.index) }; thoughts.delete(ev.index);
        } else if (ev.type === 'content_block_stop' && blocks.has(ev.index)) {
          const b = blocks.get(ev.index); yield { type: 'tool_call', id: b.id, name: b.name, args: parseArgs(b.json) }; blocks.delete(ev.index);
        } else if (ev.type === 'message_start' && ev.message?.usage) {
          const u = ev.message.usage; usage.input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0); usage.output = u.output_tokens || 0;
        } else if (ev.type === 'message_delta') {
          if (ev.usage?.output_tokens != null) usage.output = ev.usage.output_tokens;
          if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
        }
      }
      if (usage.input || usage.output) yield { type: 'usage', inputTokens: usage.input, outputTokens: usage.output };
      yield { type: 'done', stop };
    },
  };
}
