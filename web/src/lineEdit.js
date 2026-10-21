// Client copy of the server's applyLineEdit (server/src/agent/tools.js): lines are 1-based, a trailing newline is not a line of its own,
// and the file's line-ending style is kept. The Editor uses it to preview a line edit while the model is still writing the call.
// Returns { next, from, removed, added } or { error }.
export const LINE_TOOLS = { replace_lines: 'replace', delete_lines: 'delete', insert_lines: 'insert' };

export function applyLineEdit(txt, op, a) {
  const eol = txt.includes('\r\n') ? '\r\n' : '\n';
  const lines = txt.split(eol), trailing = lines.length > 1 && lines[lines.length - 1] === '';
  if (trailing) lines.pop();
  if (txt === '') lines.length = 0;
  const total = lines.length;
  const int = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : NaN);
  const c = String(a.content ?? '');
  const fresh = op === 'delete' || c === '' ? [] : c.replace(/\r?\n$/, '').split(/\r?\n/);
  let from, to;
  if (op === 'insert') {
    const after = int(a.after_line);
    if (!Number.isInteger(after) || after < 0 || after > total) return { error: 'after_line out of range' };
    from = after; to = after;
  } else {
    from = int(a.start_line); to = a.end_line === undefined || a.end_line === null ? from : int(a.end_line);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || from > total || to < from || to > total) return { error: 'line range out of range' };
    from -= 1;
  }
  const out = [...lines.slice(0, from), ...fresh, ...lines.slice(to)];
  return { next: out.join(eol) + (out.length && (trailing || total === 0) ? eol : ''), from: from + 1, removed: to - from, added: fresh.length };
}
