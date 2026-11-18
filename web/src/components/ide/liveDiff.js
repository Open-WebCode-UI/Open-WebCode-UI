// Live diff highlight for the editor: while the agent changes a file, the changed lines are painted by kind, and the lines it
// removed appear as a block just above them. Additions are green, deletions red, edits (a replaced block) amber.
// The highlight fades a moment after the last change.

const HOLD_MS = 1600;         // how long a change stays highlighted after the last update
const MAX_REMOVED_ROWS = 200; // a huge rewrite shows this many removed lines, then a note

// Colors per kind of change: the wash over the lines, the gutter bar, and the removed-lines block.
const KINDS = {
  add: { wash: 'rgba(46, 160, 67, 0.28)', bar: '#2ea043', block: null },
  edit: { wash: 'rgba(210, 153, 34, 0.28)', bar: '#d29922', block: 'rgba(210, 153, 34, 0.22)' },
  delete: { wash: null, bar: '#f85149', block: 'rgba(248, 81, 73, 0.2)' },
};

// The lines that differ between two texts: `start` (0-based, first changed line of `after`), `end` (exclusive), and the
// `removed` lines of `before`. Returns null when the texts are the same. Common lines before and after the change are skipped.
export function changedRegion(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const start = p, end = b.length - s, removed = a.slice(p, a.length - s);
  if (end === start && removed.length === 0) return null;
  return { start, end, removed };
}

// What kind of change a region is: lines only added (add), only removed (delete), or a block replaced (edit).
export function changeKind(region) {
  const added = region.end > region.start;
  if (added && region.removed.length) return 'edit';
  return added ? 'add' : 'delete';
}

let stylesAdded = false;
function ensureStyles() {
  if (stylesAdded || typeof document === 'undefined') return;
  stylesAdded = true;
  const fades = Object.entries(KINDS).filter(([, c]) => c.wash).map(([kind, c]) =>
    `@keyframes agent-diff-fade-${kind} { 0%, 70% { background-color: ${c.wash}; } 100% { background-color: transparent; } }\n` +
    `.agent-diff-${kind} { animation: agent-diff-fade-${kind} ${HOLD_MS}ms forwards; }`).join('\n');
  const blocks = Object.entries(KINDS).filter(([, c]) => c.block).map(([kind, c]) =>
    `.agent-diff-block-${kind} { background: ${c.block}; overflow: hidden; animation: agent-diff-block-fade-${kind} ${HOLD_MS}ms forwards; }\n` +
    `@keyframes agent-diff-block-fade-${kind} { 0%, 70% { background-color: ${c.block}; } 100% { background-color: transparent; } }`).join('\n');
  const bars = Object.entries(KINDS).map(([kind, c]) =>
    `.agent-diff-bar-${kind} { border-left: 3px solid ${c.bar}; margin-left: 3px; }`).join('\n');
  const el = document.createElement('style');
  el.id = 'agent-live-diff';
  el.textContent = `${fades}\n${blocks}\n${bars}
.agent-diff-del-line { border-top: 2px solid ${KINDS.delete.bar}; }
.agent-diff-row { white-space: pre; overflow: hidden; text-decoration: line-through; opacity: 0.85; padding-left: 4px; }
`;
  document.head.appendChild(el);
}

// Removes the highlight of `L` (the per-editor state object: { deco, zone, timer }).
export function clearLiveDiff(ed, L) {
  if (!L) return;
  clearTimeout(L.timer); L.timer = 0;
  try { L.deco?.clear(); } catch { /* the editor may already be disposed */ }
  L.deco = null;
  if (L.zone !== undefined && ed?.changeViewZones) { try { ed.changeViewZones((acc) => acc.removeZone(L.zone)); } catch { /* disposed */ } }
  L.zone = undefined;
}

// Paints the change `region` (from changedRegion) on the editor and schedules its fade-out.
export function showLiveDiff(ed, monaco, region, L) {
  clearLiveDiff(ed, L);
  const model = ed?.getModel?.();
  if (!model || !region || !monaco?.Range) return;
  ensureStyles();
  const kind = changeKind(region);
  const n = model.getLineCount();
  const clampLine = (l) => Math.min(Math.max(l, 1), n);
  const decos = [];
  if (region.end > region.start) {
    decos.push({ range: new monaco.Range(clampLine(region.start + 1), 1, clampLine(region.end), 1), options: { isWholeLine: true, className: `agent-diff-${kind}`, linesDecorationsClassName: `agent-diff-bar-${kind}` } });
  } else if (region.start < n) { // only lines were removed: mark the line that now follows the gap
    decos.push({ range: new monaco.Range(region.start + 1, 1, region.start + 1, 1), options: { isWholeLine: true, className: 'agent-diff-del-line' } });
  }
  if (decos.length && ed.createDecorationsCollection) L.deco = ed.createDecorationsCollection(decos);
  if (region.removed.length && ed.changeViewZones && KINDS[kind].block) {
    const lh = (monaco.editor && ed.getOption?.(monaco.editor.EditorOption.lineHeight)) || 19;
    // A view zone sits outside the editor's font context, so it takes the editor's font face and size explicitly.
    const fi = monaco.editor && ed.getOption?.(monaco.editor.EditorOption.fontInfo);
    const shown = region.removed.slice(0, MAX_REMOVED_ROWS);
    const dom = document.createElement('div');
    dom.className = `agent-diff-block-${kind}`;
    if (fi?.fontFamily) dom.style.fontFamily = fi.fontFamily;
    if (fi?.fontSize) dom.style.fontSize = `${fi.fontSize}px`;
    for (const line of shown) {
      const row = document.createElement('div');
      row.className = 'agent-diff-row';
      row.style.height = `${lh}px`;
      row.textContent = line || ' ';
      dom.appendChild(row);
    }
    if (region.removed.length > shown.length) {
      const more = document.createElement('div');
      more.className = 'agent-diff-row';
      more.style.height = `${lh}px`;
      more.textContent = `… ${region.removed.length - shown.length} more removed lines`;
      dom.appendChild(more);
    }
    const rows = shown.length + (region.removed.length > shown.length ? 1 : 0);
    ed.changeViewZones((acc) => { L.zone = acc.addZone({ afterLineNumber: Math.min(region.start, n), heightInPx: lh * rows, domNode: dom, suppressMouseDown: true }); });
  }
  L.timer = setTimeout(() => clearLiveDiff(ed, L), HOLD_MS);
}
