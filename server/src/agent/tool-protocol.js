// Detects tool calls that did not arrive through the structured tool-calling interface, and builds the corrective messages.
export const MAX_PROTOCOL_RETRIES = 2;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A registered tool name followed by something that looks like call syntax: `name { "k": ...`, `name(k=...`, `name({...})`,
// `name("...")` or `<name>`. A bare word such as "search" in prose does not match. Returns the tool name, or null.
export function findPseudoCall(text, tools) {
  if (!text) return null;
  for (const { name } of tools) {
    const n = escapeRe(name);
    if (new RegExp(`(?:^|[^\\w])${n}\\s*(?:\\{\\s*["'\\n]|\\(\\s*(?:\\w+\\s*=|["'{])|\\n\\s*\\{)|<${n}[\\s>]`).test(text)) return name;
  }
  return null;
}

const typeOk = (v, t) => (t === 'integer' ? Number.isInteger(v) : t === 'array' ? Array.isArray(v) : t === 'object' ? v && typeof v === 'object' && !Array.isArray(v) : typeof v === t);

// Minimal JSON-schema check (required, type, enum) for the arguments of a tool call. Returns a list of problems, empty when valid.
export function validateArgs(tool, args) {
  const schema = tool?.parameters;
  if (!schema?.properties) return [];
  const a = args && typeof args === 'object' ? args : {};
  const problems = [];
  for (const k of schema.required || []) {
    if (a[k] == null || (typeof a[k] === 'string' && !a[k].trim())) problems.push(`"${k}" is required`);
  }
  for (const [k, p] of Object.entries(schema.properties)) {
    if (a[k] == null) continue;
    if (p.type && !typeOk(a[k], p.type)) problems.push(`"${k}" must be of type ${p.type}`);
    else if (p.enum && !p.enum.includes(a[k])) problems.push(`"${k}" must be one of ${p.enum.map((x) => JSON.stringify(x)).join(', ')}`);
  }
  return problems;
}

export const invalidArgsMessage = (name, problems) => `Error: the arguments of ${name} were invalid, so it was not run: ${problems.join('; ')}. Call ${name} again with valid arguments.`;

export const pseudoCallNotice = (name) => `[Platform notice] You wrote ${name}(...) as plain text, so the call was not made and nothing happened. Do not write tool calls out as text. Invoke the ${name} tool itself through the tool-calling interface, as your only tool call, with its arguments filled in.`;

// Reasoning that describes a file change as already decided ("I'll write gan.ipynb in one write_file call") while no tool call has been made.
// Returns { kind: 'call', tool } when the reasoning contains call syntax for a tool, or { kind: 'intent', tool, text } when a finished sentence
// pairs a write verb and an intent phrase with a tool name or a file name. The last, possibly unfinished, piece is not checked.
const WRITE_TOOL_RE = /\b(write_file|edit_file|replace_lines|insert_lines|delete_lines|save_attachment|delete_file)\b/;
const FILE_RE = /(?:^|[\s`'"(])[\w./-]+\.(?:py|js|jsx|ts|tsx|mjs|ipynb|txt|md|json|ya?ml|html|css|scss|csv|toml|ini|sh|go|rs|java|kt|c|cc|cpp|h|sql|xml|vue|svelte)\b/i;
const WRITE_VERB_RE = /\b(write|writing|create|creating|save|saving|produce|producing|edit|editing|implement|implementing|rewrite|add|adding)\b/i;
const INTENT_RE = /\b(i'?ll|i will|i'm going to|i am going to|let me|going to|now i|next i|i'm writing|i'm creating|one\b[^.]{0,40}\bcall)\b/i;
export function writeIntentIn(thought, tools) {
  if (!thought) return null;
  const call = findPseudoCall(thought, tools);
  if (call) return { kind: 'call', tool: call };
  const pieces = thought.split(/(?<=[.!?])\s+|\n+/);
  pieces.pop(); // the last piece may still be arriving
  for (const s of pieces) {
    const tool = WRITE_TOOL_RE.exec(s)?.[1] ?? null;
    if ((tool || FILE_RE.test(s)) && WRITE_VERB_RE.test(s) && INTENT_RE.test(s)) return { kind: 'intent', tool, text: s.trim().slice(0, 160) };
  }
  return null;
}

export const thinkingActionNotice = (hit) => `[Platform notice] Your reasoning ${hit.kind === 'call' ? `wrote a ${hit.tool} call as text` : `described a file change (“${hit.text}”)`}, but no tool call was made, so nothing was written. Thinking is not writing. Stop planning and call the tool now through the tool-calling interface, with all of its arguments filled in.`;
