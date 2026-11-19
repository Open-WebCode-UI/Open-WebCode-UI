// Rainbow CSV: each column's text gets its own color, cycling through ten, as the Rainbow CSV extension for VS Code does.
// The colors are Monaco decorations on the text, so the file itself is not changed.
import { ensureStyle } from './editorStyles.js';

export const RAINBOW_COLORS = 10;
const LIGHT = ['#c62828', '#e65100', '#8d6e00', '#2e7d32', '#1565c0', '#6a1b9a', '#00838f', '#ad1457', '#4e342e', '#558b2f'];
const DARK = ['#ef9a9a', '#ffcc80', '#fff59d', '#a5d6a7', '#90caf9', '#ce93d8', '#80deea', '#f48fb1', '#bcaaa4', '#c5e1a5'];
const CSS = [...LIGHT.map((c, i) => `.csv-rb-l${i}{color:${c}}`), ...DARK.map((c, i) => `.csv-rb-d${i}{color:${c}}`)].join('');

// Lines painted above and below the visible part, so scrolling a little does not show uncolored text.
const MARGIN = 50;

// Splits CSV text into field spans: { start, end, col } with character offsets, end exclusive, and the column index.
// Uses the same quoting rules as parseCsv in csv.js (a quote opens a field only at its start, "" inside a quoted field is one quote).
export function csvSpans(text) {
  const spans = []; let col = 0, start = 0, quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') i++; else quoted = false; } }
    else if (c === '"' && i === start) quoted = true;
    else if (c === ',') { spans.push({ start, end: i, col }); col++; start = i + 1; }
    else if (c === '\r' || c === '\n') {
      spans.push({ start, end: i, col });
      if (c === '\r' && text[i + 1] === '\n') i++;
      col = 0; start = i + 1;
    }
  }
  if (start < text.length) spans.push({ start, end: text.length, col });
  return spans;
}

// Attaches rainbow coloring to a Monaco editor. set(on, dark) turns it on or off and picks the palette for a dark or light background.
// It repaints when the text, the scroll position or the model changes; it only colors CSV models.
export function createRainbow(ed, monaco) {
  ensureStyle('csv-rainbow-style', CSS);
  const coll = ed.createDecorationsCollection ? ed.createDecorationsCollection() : null;
  let on = false, dark = false;
  const paint = () => {
    const model = ed.getModel?.();
    if (!coll) return;
    if (!on || !model || !/\.csv$/i.test(model.uri?.path || '')) { coll.clear(); return; }
    const vis = ed.getVisibleRanges?.() || [];
    const lo = vis.length ? Math.max(1, Math.min(...vis.map((r) => r.startLineNumber)) - MARGIN) : 1;
    const hi = vis.length ? Math.max(...vis.map((r) => r.endLineNumber)) + MARGIN : model.getLineCount();
    const decos = [];
    for (const s of csvSpans(model.getValue())) {
      if (s.end <= s.start) continue;
      const a = model.getPositionAt(s.start), b = model.getPositionAt(s.end);
      if (b.lineNumber < lo || a.lineNumber > hi) continue;
      decos.push({ range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), options: { inlineClassName: `csv-rb-${dark ? 'd' : 'l'}${s.col % RAINBOW_COLORS}` } });
    }
    coll.set(decos);
  };
  const subs = [ed.onDidScrollChange?.(paint), ed.onDidChangeModel?.(paint), ed.onDidChangeModelContent?.(paint)].filter(Boolean);
  ed.onDidDispose?.(() => { subs.forEach((s) => s.dispose?.()); coll?.clear(); });
  return {
    set(nextOn, nextDark) { on = !!nextOn; dark = !!nextDark; paint(); },
  };
}
