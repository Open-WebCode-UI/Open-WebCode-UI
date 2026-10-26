import { estimateTokens } from '../sessions.js';
import { prefill } from './prefill.js';
import { createToolStreamer } from './tool-stream.js';
import { getToolsFor, executeTool, PlanModeViolation, TERMINAL_TOOLS } from './tools.js';
import { MAX_PROTOCOL_RETRIES, findPseudoCall, validateArgs, invalidArgsMessage, pseudoCallNotice } from './tool-protocol.js';

// Keep tool_start events small: file bodies are not streamed to the browser, edits carry short before/after excerpts for display.
const clip = (v, n = 1500) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n)}…` : v);
function displayArgs(name, a = {}) {
  if (name === 'write_file') return { path: a.path, bytes: Buffer.byteLength(a.content ?? '') };
  if (name === 'edit_file') return { path: a.path, old_string: clip(a.old_string), new_string: clip(a.new_string) };
  if (name === 'replace_lines' || name === 'insert_lines') return { ...a, content: clip(a.content) };
  return a;
}

export const INTERRUPTED_NOTE = '[Interrupted by the user before replying.]';

// Runs one agent turn: model -> tool calls -> results -> model ... until a final answer or the iteration cap.
// `messages` is mutated (neutral format, see llm/provider.js). `emit(event)` streams to the client.
export async function runAgentTurn({ adapter, model, system: baseSystem, messages, ctx, emit, signal, maxIterations = 30, maxTokens = 4096, temperature, thinking, audit, onUsage, prepare }) {
  const tools = getToolsFor(ctx);
  // Stop keeps what the model had written so far, so a later "resume" continues from it instead of repeating or contradicting it.
  // Half-streamed tool calls are dropped (their arguments cannot be trusted). When nothing was written, a placeholder keeps
  // the roles alternating, which some providers require, so the user's follow-up never lands right after another user turn.
  const interrupt = (text = '', thought = '') => {
    if (text || messages.at(-1)?.role !== 'assistant') messages.push({ role: 'assistant', content: text || INTERRUPTED_NOTE, ...(text && thought ? { thinking: thought } : {}), interrupted: text ? 'partial' : 'empty' });
    emit({ type: 'aborted' });
    return { stopped: 'aborted' };
  };
  let protocolRetries = 0, forceTool = null;
  for (let i = 0; i < maxIterations; i++) {
    if (signal?.aborted) return interrupt();
    const system = baseSystem + (ctx.coord?.note() || ''); // other running sessions can change between steps
    let text = '', thought = '';
    const calls = [], thinkingBlocks = [], drawn = [];                 // drawn: files the model generated in this reply (refs; bytes are in attachment storage)
    let reported = null;
    const sentTokens = estimateTokens(messages, system.length);
    // Until the first token arrives the model is reading the prompt, which can take minutes on a local server and every step re-reads it.
    emit({ type: 'phase', phase: 'prefill', tokens: sentTokens, etaMs: prefill.eta(model, sentTokens) });
    const started = Date.now();
    let generating = false;
    const live = createToolStreamer(emit);
    try {
      for await (const ev of adapter.stream({ system, messages: prepare ? prepare(messages) : messages, tools, model, maxTokens, temperature, thinking, signal, ...(forceTool ? { toolChoice: { name: forceTool } } : {}) })) {
        if (!generating) {
          generating = true;
          if (ev.type === 'text' || ev.type === 'thinking') prefill.record(model, sentTokens, Date.now() - started); // a tool call only arrives after generation, so it says nothing about prefill
          emit({ type: 'phase', phase: 'generating' });
        }
        if (ev.type === 'text') { text += ev.text; emit({ type: 'text', text: ev.text }); }
        else if (ev.type === 'thinking') { thought += ev.text; emit({ type: 'thinking', text: ev.text }); }
        else if (ev.type === 'media') {
          // Stored for the conversation and shown in the UI; the model is not sent its own images back.
          const a = await ctx.attachments?.saveOutput?.(ev, `generated-${drawn.length + 1}`);
          if (a) { drawn.push(a); emit({ type: 'media', attachments: [a] }); } else emit({ type: 'notice', text: 'The model returned an image that could not be shown (unsupported type or too large).' });
        }
        else if (ev.type === 'thinking_block') thinkingBlocks.push({ model: ev.model, block: ev.block }); // signed blocks, replayed to the same model
        else if (ev.type === 'tool_delta') live.delta(ev); // file contents and commands appear in the UI while the model is still writing them
        else if (ev.type === 'tool_call') calls.push(ev);
        else if (ev.type === 'usage') reported = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens };
      }
    } catch (e) {
      if (signal?.aborted) return interrupt(text, thought);
      throw e;
    } finally { live.close(); }
    // Providers that report no usage (some local servers) are costed from an estimate, flagged as such.
    await onUsage?.(reported ?? { inputTokens: sentTokens, outputTokens: Math.ceil((text.length + thought.length + calls.reduce((n, c) => n + JSON.stringify(c.args ?? {}).length, 0)) / 4), estimated: true });
    messages.push({ role: 'assistant', content: text, ...(drawn.length ? { attachments: drawn } : {}), ...(thought ? { thinking: thought } : {}), ...(thinkingBlocks.length ? { thinkingBlocks } : {}),
      ...(calls.length ? { toolCalls: calls.map(({ id, name, args }) => ({ id, name, args })) } : {}) });
    // Some models write a call such as `conclude { ... }` or `propose_plan(...)` as prose instead of making it, so nothing runs.
    // Ask for a real call (the last retry forces that tool where the provider allows it), and fail loudly rather than treat the prose as an answer.
    const pseudo = !calls.length && findPseudoCall(text, tools);
    forceTool = null;
    if (pseudo) {
      audit?.('agent.pseudo_tool_call', pseudo, { attempt: protocolRetries + 1 });
      if (protocolRetries >= MAX_PROTOCOL_RETRIES) {
        emit({ type: 'error', message: `The model kept writing the ${pseudo} call as text instead of making it, so the turn was stopped.` });
        return { stopped: 'protocol_error', text };
      }
      protocolRetries++;
      if (protocolRetries === MAX_PROTOCOL_RETRIES) forceTool = pseudo;
      messages.push({ role: 'user', content: pseudoCallNotice(pseudo) });
      continue;
    }
    if (!calls.length) { emit({ type: 'done' }); return { stopped: 'complete', text }; }
    let ended = false;
    const results = new Map(), produced = new Map();
    const runCall = async (c) => {
      emit({ type: 'tool_start', id: c.id, name: c.name, args: displayArgs(c.name, c.args) });
      let result;
      const made = [];                                                  // files the tool produced (refs; the bytes live in attachment storage)
      try {
        // Arguments that are not valid JSON are usually a call cut off by the output limit; running it would only fail with a confusing "undefined path".
        if (c.args?._parseError) throw new Error('The arguments of this tool call were incomplete or not valid JSON, so it was not run. This usually means the reply hit the output limit while writing a large file. Retry with less content per call (for example split the file into smaller files, or create it small and then extend it with edit_file).');
        // Terminal tools end the turn, so a call missing its required arguments is bounced back instead of ending it with an empty card.
        const problems = TERMINAL_TOOLS.has(c.name) ? validateArgs(tools.find((t) => t.name === c.name), c.args) : [];
        if (problems.length) throw new Error(invalidArgsMessage(c.name, problems).replace(/^Error: /, ''));
        result = await executeTool(c.name, c.args, ctx, { callId: c.id, attachments: made }); }
      catch (e) {
        if (e instanceof PlanModeViolation) audit?.('agent.plan_mode_violation', c.name, { args: c.args });
        result = `Error: ${e.message}`;
      }
      audit?.('agent.tool', c.name, { mode: ctx.agentMode, ok: !String(result).startsWith('Error:') });
      emit({ type: 'tool_result', id: c.id, name: c.name, result: String(result).slice(0, 4000), ...(made.length ? { attachments: made } : {}) });
      results.set(c.id, String(result));
      if (made.length) produced.set(c.id, made);
      if (TERMINAL_TOOLS.has(c.name) && !String(result).startsWith('Error')) ended = true;
    };
    // propose_plan must be the last word of the turn. Alongside other calls it would present the plan before the model has seen
    // their results (or before another plan call), so it is refused and the model retries it on its own in the next step.
    // (conclude may still ride along with the final edits.)
    const plans = calls.filter((c) => c.name === 'propose_plan');
    const only = calls.length === 1;
    for (const c of plans) {
      if (only) break;
      const msg = 'Error: propose_plan must be your only tool call in a message and your last action. It was not run. Finish your other tool calls first, then call propose_plan again on its own.';
      emit({ type: 'tool_start', id: c.id, name: c.name, args: displayArgs(c.name, c.args) });
      emit({ type: 'tool_result', id: c.id, name: c.name, result: msg });
      results.set(c.id, msg);
    }
    for (const c of calls) {
      if (results.has(c.id)) continue;
      // Every spawn_agent call in this message runs concurrently (the subagent runtime limits how many run at once).
      if (c.name === 'spawn_agent') await Promise.all(calls.filter((x) => x.name === 'spawn_agent' && !results.has(x.id)).map(runCall));
      else await runCall(c);
    }
    for (const c of calls) messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content: results.get(c.id), ...(produced.has(c.id) ? { attachments: produced.get(c.id) } : {}) });
    // conclude / propose_plan / switch_mode hand control back to the user.
    if (ended) { emit({ type: 'done' }); return { stopped: 'handed_back' }; }
  }
  emit({ type: 'error', message: 'Reached the maximum number of steps for one turn.' });
  return { stopped: 'max_iterations' };
}
