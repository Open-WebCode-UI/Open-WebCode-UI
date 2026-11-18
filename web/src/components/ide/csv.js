// CSV text <-> rows. Handles quoted fields, doubled quotes inside them, and line breaks inside quotes.
// Only fields that need it are quoted on the way back, so a file the grid does not touch keeps its text.
export const isCsvPath = (p) => /\.csv$/i.test(p || '');

export function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const quote = (f) => (/[",\r\n]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f);

export function toCsv(rows, trailingNewline = true) {
  const text = rows.map((r) => r.map(quote).join(',')).join('\n');
  return rows.length && trailingNewline ? `${text}\n` : text;
}
