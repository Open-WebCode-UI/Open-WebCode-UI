// Normalized streaming interface. Every adapter implements:
//   async *stream({ system, messages, tools, model, maxTokens, temperature, signal })
// yielding events: {type:'text', text} | {type:'media', mime, data:Buffer} (an image the model generated) | {type:'tool_call', id, name, args} | {type:'done', stop}
// Messages use a neutral format:
//   {role:'user'|'assistant', content:string, toolCalls?:[{id,name,args}]} | {role:'tool', toolCallId, name, content, files?}
//   `files` ([{name,mime,kind,data}], added from stored attachments just before a request) on a user or tool message carries images/PDFs
//   (tool messages: images only).
import { decrypt } from '../crypto.js';
import { openaiAdapter } from './openai.js';
import { anthropicAdapter } from './anthropic.js';
import { bedrockAdapter } from './bedrock.js';
import { vertexAdapter, geminiImageAdapter, isGeminiImageModel } from './vertex.js';

export const PROVIDER_TYPES = ['openai', 'anthropic', 'lmstudio', 'ollama', 'generic', 'gemini', 'vertex', 'mistral', 'bedrock', 'azure'];

export function createAdapter(provider, deps = {}) {
  const cfg = JSON.parse(provider.config || '{}');
  const secret = provider.secret_enc ? decrypt(provider.secret_enc) : '';
  switch (provider.type) {
    case 'gemini': {
      const compat = openaiAdapter({ type: provider.type, cfg, secret, ...deps }), native = geminiImageAdapter({ secret, client: deps.nativeClient });
      return { ...compat, stream: (opts) => (isGeminiImageModel(opts.model) ? native : compat).stream(opts) };
    }
    case 'openai': case 'lmstudio': case 'ollama': case 'generic': case 'mistral': case 'azure': return openaiAdapter({ type: provider.type, cfg, secret, ...deps });
    case 'anthropic': return anthropicAdapter({ cfg, secret, ...deps });
    case 'vertex': return vertexAdapter({ cfg, secret, ...deps });
    case 'bedrock': return bedrockAdapter({ cfg, secret, ...deps });
    default: throw new Error(`Unknown provider type ${provider.type}`);
  }
}

export const toolSchemaJson = (t) => ({ name: t.name, description: t.description, parameters: t.parameters });
const parseArgs = (s) => { try { return s ? JSON.parse(s) : {}; } catch { return { _parseError: true, raw: s }; } };
export { parseArgs };
