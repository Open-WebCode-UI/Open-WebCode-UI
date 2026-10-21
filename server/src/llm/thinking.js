// Per-model "thinking" configuration.
//   off      - send nothing (models such as DeepSeek-R1 / LM Studio reasoning models still stream their reasoning on their own)
//   adaptive - Claude 4.6+/5 family: { type: 'adaptive', display: 'summarized' } (the default display is "omitted", i.e. empty text)
//   budget   - older Claude models (Haiku 4.5, Sonnet 4.x, Opus 4.x/4.5): { type: 'enabled', budget_tokens }
export const THINKING_MODES = ['off', 'adaptive', 'budget'];
export const DEFAULT_BUDGET = 8000;

// Suggested default when an administrator adds a model without choosing; they can always change it.
export function defaultThinking(providerType, modelId) {
  const id = String(modelId || '').toLowerCase();
  if (providerType === 'vertex' || providerType === 'gemini') return /gemini-(2\.5|[3-9])/.test(id) ? { mode: 'adaptive', budget: null } : { mode: 'off', budget: null };
  if (!(providerType === 'anthropic' || (providerType === 'bedrock' && id.includes('anthropic.claude')))) return { mode: 'off', budget: null };
  if (/claude-(fable|mythos|opus|sonnet|haiku)-5/.test(id) || /claude-(opus|sonnet)-4-[6-9]/.test(id)) return { mode: 'adaptive', budget: null };
  if (/claude-(3-7|sonnet-4|opus-4|haiku-4)/.test(id)) return { mode: 'budget', budget: DEFAULT_BUDGET };
  return { mode: 'off', budget: null };
}

// Splits streamed text into answer vs <think>…</think> reasoning (some servers inline reasoning in the content stream).
// Tags may be split across chunks, so any trailing text that could start a tag is held back until it resolves.
// Gemini's OpenAI-compatible endpoint inlines thought summaries as <thought>…</thought>, so the tag name is configurable.
export class ThinkSplitter {
  constructor(tagName = 'think') { this.open = `<${tagName}>`; this.close = `</${tagName}>`; this.inThink = false; this.buf = ''; }
  feed(chunk) {
    this.buf += chunk;
    const out = [];
    for (;;) {
      const tag = this.inThink ? this.close : this.open;
      const i = this.buf.indexOf(tag);
      if (i >= 0) {
        if (i > 0) out.push({ kind: this.inThink ? 'thinking' : 'text', text: this.buf.slice(0, i) });
        this.buf = this.buf.slice(i + tag.length); this.inThink = !this.inThink;
        continue;
      }
      // hold back a possible partial tag at the end of the buffer
      let keep = 0;
      for (let n = Math.min(tag.length - 1, this.buf.length); n > 0; n--) if (tag.startsWith(this.buf.slice(-n))) { keep = n; break; }
      const emit = this.buf.slice(0, this.buf.length - keep);
      if (emit) out.push({ kind: this.inThink ? 'thinking' : 'text', text: emit });
      this.buf = this.buf.slice(this.buf.length - keep);
      return out;
    }
  }
  flush() { const t = this.buf; this.buf = ''; return t ? [{ kind: this.inThink ? 'thinking' : 'text', text: t }] : []; }
}

// Thinking blocks carry signatures and are only valid on the model that produced them; replay only on a match.
export const replayable = (m, model) => (m.thinkingBlocks || []).filter((b) => b.model === model).map((b) => b.block);
