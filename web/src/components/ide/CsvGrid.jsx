import { useMemo, useRef, useState } from 'react';
import { Box, Button, Divider, Menu, MenuItem, Stack, Typography } from '@mui/material';
import { parseCsv, toCsv } from './csv.js';
import { insertRow, insertColumn, deleteRow, deleteColumn, clearRange, mergeRange } from './csvOps.js';

// Spreadsheet-style view of a CSV file. It edits the same text as the Text view, so save, the unsaved marker and the agent's live
// updates work the same way. Read only when the file cannot be written (or the agent is writing it).
// Right-click (or the Menu key, Shift+F10) on a row number, a column letter or a cell opens its options. Click, Shift+click and drag select cells.
const CELL = { border: '1px solid', borderColor: 'divider', padding: 0, minWidth: 120 };
const HEAD = { ...CELL, background: 'action.hover', fontWeight: 500, padding: '2px 6px', textAlign: 'left', whiteSpace: 'nowrap' };
const INPUT = { width: '100%', border: 0, outline: 0, background: 'transparent', color: 'inherit', font: 'inherit', padding: '4px 6px', boxSizing: 'border-box' };

// 0 -> A, 25 -> Z, 26 -> AA
const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
// Normalises two corner cells into an inclusive range.
const norm = (a, b) => ({ r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) });
const inRange = (s, r, c) => !!s && r >= s.r1 && r <= s.r2 && c >= s.c1 && c <= s.c2;

export default function CsvGrid({ text, onChange, readOnly }) {
  const { rows, width, trailing } = useMemo(() => {
    const r = parseCsv(text);
    return { rows: r, width: r.reduce((m, x) => Math.max(m, x.length), 1), trailing: text.endsWith('\n') };
  }, [text]);
  const [anchor, setAnchor] = useState(null), [focus, setFocus] = useState(null);
  const [menu, setMenu] = useState(null); // { x, y, kind: 'row' | 'col' | 'cell', r, c }
  const dragging = useRef(false);
  const sel = anchor && focus ? norm(anchor, focus) : null;
  const multi = !!sel && (sel.r2 > sel.r1 || sel.c2 > sel.c1);

  const commit = (next) => onChange(toCsv(next, trailing));
  const selectCell = (r, c) => { setAnchor({ r, c }); setFocus({ r, c }); };
  // A structural change moves the cells around, so the old selection is dropped.
  const apply = (next) => { setAnchor(null); setFocus(null); commit(next); };
  const setCell = (r, c, v) => {
    const next = rows.map((x) => x.slice());
    while (next[r].length <= c) next[r].push('');
    next[r][c] = v; commit(next);
  };

  const openMenu = (e, kind, r, c) => {
    if (readOnly) return;
    e.preventDefault();
    if (kind === 'cell' && !inRange(sel, r, c)) selectCell(r, c);
    setMenu({ x: e.clientX, y: e.clientY, kind, r, c });
  };
  const openFromKeyboard = (e, r, c) => {
    if (readOnly || !(e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return;
    e.preventDefault();
    if (!inRange(sel, r, c)) selectCell(r, c);
    const box = e.currentTarget.getBoundingClientRect();
    setMenu({ x: box.left, y: box.bottom, kind: 'cell', r, c });
  };
  const onCellDown = (e, r, c) => {
    if (e.button !== 0) return;
    if (e.shiftKey && anchor) { e.preventDefault(); setFocus({ r, c }); return; }
    selectCell(r, c); dragging.current = true;
  };
  const onCellEnter = (r, c) => { if (dragging.current) setFocus({ r, c }); };

  const items = (m) => {
    const { kind, r, c } = m;
    if (kind === 'row') return [
      { label: 'Insert row above', run: () => apply(insertRow(rows, r, width)) },
      { label: 'Insert row below', run: () => apply(insertRow(rows, r + 1, width)) },
      'divider',
      { label: 'Delete row', run: () => apply(deleteRow(rows, r)) },
    ];
    if (kind === 'col') return [
      { label: 'Insert column left', run: () => apply(insertColumn(rows, c, width)) },
      { label: 'Insert column right', run: () => apply(insertColumn(rows, c + 1, width)) },
      'divider',
      { label: 'Delete column', run: () => apply(deleteColumn(rows, c)) },
    ];
    const range = sel || { r1: r, c1: c, r2: r, c2: c };
    return [
      { label: 'Insert row above', run: () => apply(insertRow(rows, r, width)) },
      { label: 'Insert row below', run: () => apply(insertRow(rows, r + 1, width)) },
      { label: 'Insert column left', run: () => apply(insertColumn(rows, c, width)) },
      { label: 'Insert column right', run: () => apply(insertColumn(rows, c + 1, width)) },
      'divider',
      { label: 'Clear contents', run: () => apply(clearRange(rows, range)) },
      { label: 'Merge cells', disabled: !multi, run: () => { commit(mergeRange(rows, range, width)); selectCell(range.r1, range.c1); } },
    ];
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }} data-testid="csv-grid">
      <Stack direction="row" spacing={1} sx={{ p: 1, alignItems: 'center', borderBottom: 1, borderColor: 'divider', flexWrap: 'wrap' }}>
        <Button size="small" disabled={readOnly} onClick={() => apply([...rows, Array(width).fill('')])}>Add row</Button>
        <Button size="small" disabled={readOnly} onClick={() => apply(rows.map((x) => { const y = x.slice(); while (y.length < width) y.push(''); y.push(''); return y; }))}>Add column</Button>
        <Typography variant="caption" color="text.secondary">{rows.length} {rows.length === 1 ? 'row' : 'rows'}, {width} {width === 1 ? 'column' : 'columns'}</Typography>
        {!readOnly && <Typography variant="caption" color="text.secondary">Right-click a row, column or cell for more options.</Typography>}
      </Stack>
      <Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto', '& .sel': { bgcolor: 'action.selected' } }}>
        <Box component="table" onMouseUp={() => { dragging.current = false; }} onMouseLeave={() => { dragging.current = false; }} sx={{ borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ ...HEAD, minWidth: 0 }} aria-label="Row numbers" />
              {Array.from({ length: width }, (_, c) => (
                <th key={c} style={HEAD} scope="col" onContextMenu={(e) => openMenu(e, 'col', 0, c)}>{colName(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                <th scope="row" style={{ ...HEAD, textAlign: 'right', minWidth: 0 }} onContextMenu={(e) => openMenu(e, 'row', r, 0)}>{r + 1}</th>
                {Array.from({ length: width }, (_, c) => (
                  <td key={c} style={CELL} className={inRange(sel, r, c) ? 'sel' : undefined}
                    onMouseDown={(e) => onCellDown(e, r, c)} onMouseEnter={() => onCellEnter(r, c)} onContextMenu={(e) => openMenu(e, 'cell', r, c)}>
                    <input aria-label={`Row ${r + 1}, column ${colName(c)}`} value={row[c] ?? ''} readOnly={readOnly} style={INPUT}
                      onChange={(e) => setCell(r, c, e.target.value)} onKeyDown={(e) => openFromKeyboard(e, r, c)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </Box>
      </Box>
      <Menu open={!!menu} onClose={() => setMenu(null)} anchorReference="anchorPosition" anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined}>
        {menu && items(menu).map((it, i) => (it === 'divider'
          ? <Divider key={`d${i}`} />
          : <MenuItem key={it.label} disabled={!!it.disabled} onClick={() => { setMenu(null); it.run(); }}>{it.label}</MenuItem>))}
      </Menu>
    </Box>
  );
}
