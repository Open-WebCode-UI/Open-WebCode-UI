// Pure Markdown formatting for a plain textarea: each function takes the text and the selection and returns the new text plus the
// selection to restore, so the buttons insert the markup itself (asterisks, backticks, ...) and place the cursor where typing continues.
const INLINE = { bold: '**', italic: '*', strike: '~~', code: '`' };
const PREFIX = { heading: '## ', bullet: '- ', quote: '> ' };

function inline(text, a, b, mark) {
  const n = mark.length, sel = text.slice(a, b);
  // Toggle off: markers just outside the selection, or the selection includes them.
  if (text.slice(a - n, a) === mark && text.slice(b, b + n) === mark && !(mark === '*' && (text[a - 2] === '*' || text[b + 1] === '*'))) return { text: text.slice(0, a - n) + sel + text.slice(b + n), start: a - n, end: b - n };
  if (sel.length >= 2 * n && sel.startsWith(mark) && sel.endsWith(mark) && !(mark === '*' && sel.startsWith('**'))) return { text: text.slice(0, a) + sel.slice(n, -n) + text.slice(b), start: a, end: b - 2 * n };
  return { text: text.slice(0, a) + mark + sel + mark + text.slice(b), start: a + n, end: b + n }; // empty selection: caret between the markers
}

function codeBlock(text, a, b) {
  const sel = text.slice(a, b), lead = a > 0 && text[a - 1] !== '\n' ? '\n' : '', trail = b < text.length && text[b] !== '\n' ? '\n' : '';
  const body = `${lead}\`\`\`\n${sel}\n\`\`\`${trail}`, open = a + lead.length + 4;
  return { text: text.slice(0, a) + body + text.slice(b), start: open, end: open + sel.length }; // caret on the line inside the fence
}

function lines(text, a, b, kind) {
  const from = text.lastIndexOf('\n', a - 1) + 1, e = text.indexOf('\n', b > a && text[b - 1] === '\n' ? b - 1 : b), to = e < 0 ? text.length : e;
  const ls = text.slice(from, to).split('\n');
  const re = kind === 'numbered' ? /^\d+\.\s/ : kind === 'heading' ? /^## / : new RegExp(`^${PREFIX[kind].trim()}\\s`.replace('-', '[-*+]'));
  const on = ls.every((l) => re.test(l));
  const out = ls.map((l, i) => (on ? l.replace(re, '') : `${kind === 'numbered' ? `${i + 1}. ` : PREFIX[kind]}${(kind === 'heading' ? l.replace(/^#{1,6}\s/, '') : l)}`));
  const next = out.join('\n');
  const single = a === b; // keep a lone caret on its line, just after the marker
  const delta = out[0].length - ls[0].length;
  return { text: text.slice(0, from) + next + text.slice(to), start: single ? Math.max(from, a + delta) : from, end: single ? Math.max(from, a + delta) : from + next.length };
}

export function applyFormat(text, a, b, kind) {
  if (INLINE[kind]) return inline(text, a, b, INLINE[kind]);
  if (kind === 'codeBlock') return codeBlock(text, a, b);
  return lines(text, a, b, kind);
}
