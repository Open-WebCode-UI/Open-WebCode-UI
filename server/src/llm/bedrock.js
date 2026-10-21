import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { parseArgs } from './provider.js';
import { replayable } from './thinking.js';

// Stored thinking blocks -> Converse reasoningContent blocks (redacted payloads are kept as base64 in our JSON store).
const toReasoning = (b) => ({ reasoningContent: b.kind === 'redacted' ? { redactedContent: Buffer.from(b.b64, 'base64') } : { reasoningText: { text: b.text, signature: b.signature } } });

// Converse restricts document names to letters, digits, spaces, hyphens, parentheses, and square brackets.
const docName = (n) => String(n).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9 ()[\]-]+/g, '-').replace(/\s+/g, ' ').slice(0, 60).trim() || 'document';

export function buildRequest({ system, messages, tools, model, maxTokens, temperature, thinking, toolChoice }) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const imgs = (m.files || []).filter((f) => f.kind === 'image').map((f) => ({ image: { format: f.mime.split('/')[1], source: { bytes: f.data } } }));
      const block = { toolResult: { toolUseId: m.toolCallId, content: [{ text: m.content || '(empty)' }, ...imgs] } };
      const last = out[out.length - 1];
      if (last?.role === 'user' && last.content[0]?.toolResult) last.content.push(block); else out.push({ role: 'user', content: [block] });
    } else if (m.role === 'assistant' && (m.toolCalls?.length || replayable(m, model).length)) {
      out.push({ role: 'assistant', content: [...replayable(m, model).map(toReasoning), ...(m.content ? [{ text: m.content }] : []), ...(m.toolCalls || []).map((c) => ({ toolUse: { toolUseId: c.id, name: c.name, input: c.args } }))] });
    } else if (m.role === 'user' && m.files?.length) {
      out.push({ role: 'user', content: [{ text: m.content || ' ' }, ...m.files.map((f) => (f.kind === 'pdf'
        ? { document: { format: 'pdf', name: docName(f.name), source: { bytes: f.data } } }
        : { image: { format: f.mime.split('/')[1], source: { bytes: f.data } } }))] });
    } else out.push({ role: m.role, content: [{ text: m.content || ' ' }] });
  }
  const think = thinking?.mode === 'adaptive' ? { type: 'adaptive', display: 'summarized' } : thinking?.mode === 'budget' ? { type: 'enabled', budget_tokens: thinking.budget } : null;
  const req = { modelId: model, system: [{ text: system }], messages: out, inferenceConfig: { maxTokens: think?.budget_tokens ? Math.max(maxTokens, think.budget_tokens + 1024) : maxTokens, ...(temperature != null && !think ? { temperature } : {}) } };
  if (think) req.additionalModelRequestFields = { thinking: think };
  if (tools?.length) req.toolConfig = { tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.parameters } } })) };
  if (toolChoice?.name && req.toolConfig && !think) req.toolConfig.toolChoice = { tool: { name: toolChoice.name } }; // not allowed together with thinking
  return req;
}

const credsOf = (secret) => {
  // secret = "ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]" or empty to use the default AWS credential chain / IAM role.
  const [accessKeyId, secretAccessKey, sessionToken] = (secret || '').split(':');
  return accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey, sessionToken } } : {};
};

export function bedrockAdapter({ cfg, secret, client, controlClient }) {
  const make = () => {
    if (client) return client;
    // secret = "ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]" or empty to use the default AWS credential chain / IAM role.
    const [accessKeyId, secretAccessKey, sessionToken] = (secret || '').split(':');
    return new BedrockRuntimeClient({ region: cfg.region, ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey, sessionToken } } : {}) });
  };
  return {
    buildRequest,
    // Text-output foundation models that support on-demand inference, plus cross-region inference profiles (newer models need these ids).
    async listModels() {
      const { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } = await import('@aws-sdk/client-bedrock');
      const c = controlClient || new BedrockClient({ region: cfg.region, ...credsOf(secret) });
      const fm = await c.send(new ListFoundationModelsCommand({ byOutputModality: 'TEXT' }));
      const ids = new Set((fm.modelSummaries || []).filter((m) => !m.inferenceTypesSupported || m.inferenceTypesSupported.includes('ON_DEMAND')).map((m) => m.modelId));
      try {
        const ip = await c.send(new ListInferenceProfilesCommand({ maxResults: 100 }));
        for (const p of ip.inferenceProfileSummaries || []) ids.add(p.inferenceProfileId);
      } catch { /* profiles are optional (missing permission / unsupported region) */ }
      return [...ids].sort();
    },
    async *stream(args) {
      const res = await make().send(new ConverseStreamCommand(buildRequest(args)), { abortSignal: args.signal });
      const blocks = new Map(), reasoning = new Map();
      let stop = 'end_turn', usage = null;
      for await (const ev of res.stream) {
        if (ev.contentBlockStart?.start?.toolUse) {
          const t = ev.contentBlockStart.start.toolUse;
          blocks.set(ev.contentBlockStart.contentBlockIndex, { id: t.toolUseId, name: t.name, json: '' });
          yield { type: 'tool_delta', id: t.toolUseId, name: t.name, delta: '' };
        } else if (ev.contentBlockDelta) {
          const d = ev.contentBlockDelta;
          if (d.delta?.text) yield { type: 'text', text: d.delta.text };
          if (d.delta?.toolUse) {
            const b = blocks.get(d.contentBlockIndex); b.json += d.delta.toolUse.input;
            yield { type: 'tool_delta', id: b.id, name: b.name, delta: d.delta.toolUse.input };
          }
          const rc = d.delta?.reasoningContent;
          if (rc) {
            const r = reasoning.get(d.contentBlockIndex) || { kind: 'text', text: '', signature: '' };
            if (rc.text) { r.text += rc.text; yield { type: 'thinking', text: rc.text }; }
            if (rc.signature) r.signature = rc.signature;
            if (rc.redactedContent) { r.kind = 'redacted'; r.b64 = Buffer.from(rc.redactedContent).toString('base64'); }
            reasoning.set(d.contentBlockIndex, r);
          }
        } else if (ev.contentBlockStop && reasoning.has(ev.contentBlockStop.contentBlockIndex)) {
          yield { type: 'thinking_block', model: args.model, block: reasoning.get(ev.contentBlockStop.contentBlockIndex) }; reasoning.delete(ev.contentBlockStop.contentBlockIndex);
        } else if (ev.contentBlockStop && blocks.has(ev.contentBlockStop.contentBlockIndex)) {
          const b = blocks.get(ev.contentBlockStop.contentBlockIndex); yield { type: 'tool_call', id: b.id, name: b.name, args: parseArgs(b.json) };
        } else if (ev.messageStop) stop = ev.messageStop.stopReason;
        else if (ev.metadata?.usage) usage = { inputTokens: ev.metadata.usage.inputTokens || 0, outputTokens: ev.metadata.usage.outputTokens || 0 };
      }
      if (usage) yield { type: 'usage', ...usage };
      yield { type: 'done', stop };
    },
  };
}
