// Live view of tool calls while the model is still writing them. Providers stream a call's arguments as partial JSON; this pulls
// the human-readable string fields (path, file content, edit text, command) out of that partial JSON and forwards only the new
// characters, batched, as `tool_progress` events. The finished call still arrives through the normal tool_start/tool_result path.

// Which string arguments are worth showing live, per tool.
export const STREAMED_FIELDS = {
  write_file: ['path', 'content'],
  edit_file: ['path', 'old_string', 'new_string'],
  replace_lines: ['path', 'start_line', 'end_line', 'content'],
  delete_lines: ['path', 'start_line', 'end_line'],
  insert_lines: ['path', 'after_line', 'content'],
  run_command: ['command'],
  propose_plan: ['plan'],
  create_page: ['title', 'markdown'],
  update_page: ['page_id', 'title', 'markdown'],
};
const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' };

// Reads the JSON string starting at s[i] (an opening quote). Tolerates truncation: returns what has arrived so far.
function readString(s, i) {
  let out = '';
  for (i += 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"') return { value: out, end: i + 1, closed: true };
    if (c !== '\\') { out += c; continue; }
    const n = s[i + 1];
    if (n === undefined) break;
    if (n === 'u') {
      const hex = s.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16)); i += 5;
    } else { out += ESCAPES[n] ?? n; i += 1; }
  }
  return { value: out, end: s.length, closed: false };
}

// Top-level string values of a (possibly unfinished) JSON object, limited to `keys`.
export function partialStrings(json, keys, closed = new Set()) {
  const found = {};
  let i = json.indexOf('{');
  if (i < 0) return found;
  i += 1;
  while (i < json.length) {
    while (i < json.length && /[\s,]/.test(json[i])) i++;
    if (json[i] !== '"') break;
    const key = readString(json, i);
    if (!key.closed) break;
    i = key.end;
    while (i < json.length && /\s/.test(json[i])) i++;
    if (json[i] !== ':') break;
    i += 1;
    while (i < json.length && /\s/.test(json[i])) i++;
    if (i >= json.length) break;
    if (json[i] === '"') {
      const v = readString(json, i);
      if (keys.includes(key.value)) { found[key.value] = v.value; if (v.closed) closed.add(key.value); }
      if (!v.closed) break;
      i = v.end;
    } else { // number, boolean, object, or array: skip to the next top-level comma
      if (keys.includes(key.value) && /[-\d]/.test(json[i])) { // a number: report it as text, and only call it closed once its end has arrived
        const m = /^-?\d+/.exec(json.slice(i));
        if (m) { found[key.value] = m[0]; if (i + m[0].length < json.length) closed.add(key.value); }
      }
      let depth = 0;
      for (; i < json.length; i++) {
        const c = json[i];
        if (c === '"') { const v = readString(json, i); i = v.end - 1; if (!v.closed) break; }
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') { if (depth === 0) break; depth--; }
        else if (c === ',' && depth === 0) break;
      }
    }
  }
  return found;
}

export function createToolStreamer(emit, { intervalMs = 60 } = {}) {
  const calls = new Map(); // id -> { name, json, sent: {field: charsAlreadySent}, closed: fields whose value is complete }
  let timer = null;
  const flushOne = (id, c) => {
    const keys = STREAMED_FIELDS[c.name];
    if (!keys) return;
    const closed = new Set(), now = partialStrings(c.json, keys, closed), fields = {};
    for (const k of keys) {
      const v = now[k] ?? '';
      if (v.length > (c.sent[k] || 0)) { fields[k] = v.slice(c.sent[k] || 0); c.sent[k] = v.length; }
    }
    // A model that names its arguments differently (e.g. "file_path") would otherwise show nothing at all: fall back to the raw JSON.
    if (!Object.keys(now).length && c.json.length > (c.sent.raw || 0)) { fields.raw = c.json.slice(c.sent.raw || 0); c.sent.raw = c.json.length; }
    // `closed` lets the UI tell a finished path ("src/a.js") from one still arriving ("src/a"), before it opens or creates anything.
    const newlyClosed = [...closed].filter((k) => !c.closed.has(k));
    newlyClosed.forEach((k) => c.closed.add(k));
    if (Object.keys(fields).length || newlyClosed.length) emit({ type: 'tool_progress', id, name: c.name, fields, closed: [...c.closed] });
  };
  const flush = () => { clearTimeout(timer); timer = null; for (const [id, c] of calls) flushOne(id, c); };
  return {
    // ev: { id, name, delta } as yielded by the provider adapters
    delta({ id, name, delta }) {
      let c = calls.get(id);
      if (!c) {
        c = { name, json: '', sent: {}, closed: new Set() }; calls.set(id, c);
        if (STREAMED_FIELDS[name]) emit({ type: 'tool_progress', id, name, fields: {} }); // the card appears as soon as the model names the tool
      }
      if (name && !c.name) c.name = name;
      c.json += delta || '';
      if (!timer && delta) timer = setTimeout(flush, intervalMs);
    },
    flush,
    close() { flush(); calls.clear(); },
  };
}
