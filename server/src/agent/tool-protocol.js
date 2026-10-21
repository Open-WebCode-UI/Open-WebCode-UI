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
