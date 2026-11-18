// Edits to CSV rows behind the grid's menus. Each returns new rows; the input is not changed.
// A range is { r1, c1, r2, c2 } with r1 <= r2 and c1 <= c2 (inclusive).
const pad = (row, width) => { const y = row.slice(); while (y.length < width) y.push(''); return y; };
const inside = (s, r, c) => r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2;

export const insertRow = (rows, index, width) => { const next = rows.slice(); next.splice(index, 0, Array(width).fill('')); return next; };
export const insertColumn = (rows, index, width) => rows.map((x) => { const y = pad(x, width); y.splice(index, 0, ''); return y; });
export const deleteRow = (rows, r) => rows.filter((_, i) => i !== r);
export const deleteColumn = (rows, c) => rows.map((x) => x.filter((_, i) => i !== c));
export const clearRange = (rows, s) => rows.map((x, r) => x.map((v, c) => (inside(s, r, c) ? '' : v)));

// CSV has no merged cells, so merging writes the non-empty values of the range, joined by a space, into its top-left cell and empties the rest.
export const mergeRange = (rows, s, width) => {
  const next = rows.map((x) => pad(x, width));
  const parts = [];
  for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) {
    const v = next[r]?.[c] ?? '';
    if (v.trim()) parts.push(v);
    if (next[r]) next[r][c] = '';
  }
  next[s.r1][s.c1] = parts.join(' ');
  return next;
};
