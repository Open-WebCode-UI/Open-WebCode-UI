// IDE layout as a tree of splits (like VS Code): every pane, the editor included, is a leaf, so any pane can be dropped
// beside any other (creating a split) or at a window edge. The functions here are pure: they take and return plain
// objects, which keeps them easy to test, and panes stay mounted at a stable place in the React tree (moving a pane
// never restarts it, so a streaming agent turn or an unsaved editor survives).
//
//   node  = { t: 'pane', p: <name> } | { t: 'split', d: 'row' | 'col', c: [{ n: node, w: weight }, ...] }
//   layout = { v: 2, root: node, hidden: [<pane names>] }
export const PANES = ['explorer', 'sessions', 'editor', 'terminal', 'chat', 'status', 'contact'];
export const PANE_TITLES = { explorer: 'Explorer', sessions: 'Sessions', editor: 'Editor', terminal: 'Terminal', chat: 'Agent', status: 'Platform status', contact: 'Contact' };
export const HIDEABLE = ['explorer', 'sessions', 'terminal', 'chat', 'status', 'contact'];
const HIDDEN_BY_DEFAULT = ['status', 'contact']; // panes a layout starts without; they are shown from the Layout menu // the editor is always visible
export const HANDLE = 6;
const MIN = { w: { editor: 260, chat: 240, terminal: 200, explorer: 160, sessions: 160, status: 220, contact: 180 }, h: { editor: 140, chat: 160, terminal: 80, explorer: 100, sessions: 80, status: 100, contact: 60 } };
const STORAGE_KEY = 'ide-layout-v2', LEGACY_KEY = 'ide-layout-v1';

const P = (p) => ({ t: 'pane', p });
const S = (d, ...c) => ({ t: 'split', d, c: c.map(([n, w]) => ({ n, w })) });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const DEFAULT_LAYOUT = Object.freeze({
  v: 2, hidden: [...HIDDEN_BY_DEFAULT],
  root: S('row', [S('col', [P('explorer'), 0.6], [P('sessions'), 0.4]), 260], [S('col', [P('editor'), 560], [P('terminal'), 240]), 700], [P('chat'), 440]),
});

// Presets: the visible arrangement of each; panes not listed are hidden.
export const PRESETS = {
  default: { label: 'Default (chat on the right, terminal below)', make: () => structuredClone(DEFAULT_LAYOUT) },
  chatLeft: { label: 'Chat on the left', make: () => ({ v: 2, hidden: [...HIDDEN_BY_DEFAULT], root: S('row', [P('chat'), 400], [S('col', [P('explorer'), 0.6], [P('sessions'), 0.4]), 240], [S('col', [P('editor'), 560], [P('terminal'), 240]), 760]) }) },
  chatBottom: { label: 'Chat and terminal at the bottom', make: () => ({ v: 2, hidden: [...HIDDEN_BY_DEFAULT], root: S('row', [S('col', [P('explorer'), 0.6], [P('sessions'), 0.4]), 260], [S('col', [P('editor'), 540], [S('row', [P('chat'), 640], [P('terminal'), 360]), 300]), 1140]) }) },
  stackedRight: { label: 'Chat and terminal stacked on the right', make: () => ({ v: 2, hidden: [...HIDDEN_BY_DEFAULT], root: S('row', [S('col', [P('explorer'), 0.6], [P('sessions'), 0.4]), 260], [P('editor'), 700], [S('col', [P('chat'), 560], [P('terminal'), 240]), 440]) }) },
  focus: { label: 'Editor only', make: () => ({ v: 2, hidden: [...HIDEABLE], root: P('editor') }) },
};

// ---------- tree helpers
const isSplit = (n) => n.t === 'split';
export function leaves(n, out = []) { if (isSplit(n)) n.c.forEach((x) => leaves(x.n, out)); else out.push(n.p); return out; }
export const visiblePanes = (l) => leaves(l.root);

// Removes single-child splits and merges a split into its parent when both run the same way. Weights are preserved proportionally.
function tidy(n) {
  if (!isSplit(n)) return n;
  let c = n.c.map((x) => ({ n: tidy(x.n), w: x.w }));
  c = c.flatMap((x) => {
    if (isSplit(x.n) && x.n.d === n.d) { const sum = x.n.c.reduce((a, y) => a + y.w, 0) || 1; return x.n.c.map((y) => ({ n: y.n, w: (y.w / sum) * x.w })); }
    return [x];
  });
  return c.length === 1 ? c[0].n : { ...n, c };
}
function without(n, pane) {
  if (!isSplit(n)) return n.p === pane ? null : n;
  const c = n.c.flatMap((x) => { const m = without(x.n, pane); return m ? [{ n: m, w: x.w }] : []; });
  return c.length ? { ...n, c } : null;
}
const totalW = (n) => n.c.reduce((a, x) => a + x.w, 0);

// ---------- validation / migration
function validNode(n, seen, depth = 0) {
  if (!n || typeof n !== 'object' || depth > 12) return null;
  if (n.t === 'pane') { if (!PANES.includes(n.p) || seen.has(n.p)) return null; seen.add(n.p); return P(n.p); }
  if (n.t === 'split' && (n.d === 'row' || n.d === 'col') && Array.isArray(n.c)) {
    const c = n.c.flatMap((x) => { const m = validNode(x?.n, seen, depth + 1); return m ? [{ n: m, w: Number.isFinite(x.w) && x.w > 0 ? Math.min(x.w, 1e6) : 1 }] : []; });
    return c.length ? { t: 'split', d: n.d, c } : null;
  }
  return null;
}
function fromLegacy(raw) { // v1: { docks: { explorer|chat|terminal: left|right|bottom|hidden }, sizes }
  const d = raw.docks || {}, s = raw.sizes || {};
  const at = (dock) => ['explorer', 'chat', 'terminal'].filter((p) => d[p] === dock);
  const stack = (names, dir) => (names.length === 1 ? P(names[0]) : S(dir, ...names.map((p) => [P(p), 1])));
  let center = P('editor');
  if (at('bottom').length) center = S('col', [center, 560], [stack(at('bottom'), 'row'), Number(s.bottom) || 240]);
  const parts = [];
  if (at('left').length) parts.push([stack(at('left'), 'col'), Number(s.left) || 260]);
  parts.push([center, 700]);
  if (at('right').length) parts.push([stack(at('right'), 'col'), Number(s.right) || 440]);
  const hidden = [...['explorer', 'chat', 'terminal'].filter((p) => !['left', 'right', 'bottom'].includes(d[p])), 'sessions'];
  return { v: 2, hidden, root: parts.length === 1 ? parts[0][0] : S('row', ...parts) };
}
export function normalizeLayout(raw) {
  if (!raw || typeof raw !== 'object') return structuredClone(DEFAULT_LAYOUT);
  if (raw.docks && !raw.root) raw = fromLegacy(raw);
  const seen = new Set();
  let root = validNode(raw.root, seen);
  if (!root) return structuredClone(DEFAULT_LAYOUT);
  const hidden = [...new Set((Array.isArray(raw.hidden) ? raw.hidden : []).filter((p) => HIDEABLE.includes(p) && !seen.has(p)))];
  let layout = { v: 2, root: tidy(root), hidden };
  if (!seen.has('editor')) layout = { ...layout, root: tidy(S('row', [P('editor'), 700], [layout.root, 440])) }; // the editor must always exist
  for (const p of PANES) if (!visiblePanes(layout).includes(p) && !layout.hidden.includes(p)) layout = HIDDEN_BY_DEFAULT.includes(p) ? { ...layout, hidden: [...layout.hidden, p] } : showPane(layout, p); // a pane the stored layout never knew about
  return layout;
}
export function loadLayout() {
  try {
    const v2 = localStorage.getItem(STORAGE_KEY); if (v2) return normalizeLayout(JSON.parse(v2));
    const v1 = localStorage.getItem(LEGACY_KEY); if (v1) return normalizeLayout(JSON.parse(v1));
  } catch { /* corrupt or unavailable storage: use the default */ }
  return structuredClone(DEFAULT_LAYOUT);
}
export function hasSavedLayout() { try { return !!(localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_KEY)); } catch { return false; } }
export function saveLayout(l) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(l)); } catch { /* storage unavailable */ } }
export const resetLayout = () => structuredClone(DEFAULT_LAYOUT);
export const applyPreset = (l, key) => (PRESETS[key] ? normalizeLayout(PRESETS[key].make()) : l);

// ---------- geometry
const minOf = (n, axis) => {
  if (!isSplit(n)) return MIN[axis][n.p];
  const along = (n.d === 'row') === (axis === 'w');
  const kids = n.c.map((x) => minOf(x.n, axis));
  return along ? kids.reduce((a, b) => a + b, 0) + (kids.length - 1) * HANDLE : Math.max(...kids);
};
// Splits `total` px by weight while honoring each child's minimum (children at their minimum keep it; the rest share what is left).
function allocate(weights, mins, total) {
  const n = weights.length, size = new Array(n).fill(0), fixed = new Array(n).fill(false);
  if (total <= mins.reduce((a, b) => a + b, 0)) { const sum = mins.reduce((a, b) => a + b, 0) || 1; return mins.map((m) => (m / sum) * Math.max(0, total)); }
  for (let pass = 0; pass <= n; pass++) {
    const free = weights.reduce((a, w, i) => a + (fixed[i] ? 0 : w), 0), left = total - size.reduce((a, s, i) => a + (fixed[i] ? s : 0), 0);
    let changed = false;
    weights.forEach((w, i) => { if (fixed[i]) return; size[i] = (w / free) * left; if (size[i] < mins[i]) { size[i] = mins[i]; fixed[i] = true; changed = true; } });
    if (!changed) break;
  }
  return size;
}
const titleOf = (n) => PANE_TITLES[leaves(n)[0]];

// -> { rects: { pane: {x,y,w,h} | null }, handles: [{ id, path, index, orientation, rect, sizes, mins, label }] }
export function computeRects(layout, W, H) {
  const rects = Object.fromEntries(PANES.map((p) => [p, null])), handles = [];
  const walk = (n, r, path) => {
    if (!isSplit(n)) { rects[n.p] = r; return; }
    const row = n.d === 'row', axis = row ? 'w' : 'h', cross = row ? 'h' : 'w', total = (row ? r.w : r.h) - (n.c.length - 1) * HANDLE;
    const mins = n.c.map((x) => minOf(x.n, axis)), sizes = allocate(n.c.map((x) => x.w), mins, total);
    let pos = row ? r.x : r.y;
    n.c.forEach((x, i) => {
      walk(x.n, row ? { x: pos, y: r.y, w: sizes[i], h: r.h } : { x: r.x, y: pos, w: r.w, h: sizes[i] }, [...path, i]);
      pos += sizes[i];
      if (i < n.c.length - 1) {
        handles.push({ id: `split:${path.join('.') || 'root'}:${i}`, path, index: i, orientation: row ? 'vertical' : 'horizontal', sizes, mins, rect: row ? { x: pos, y: r.y, w: HANDLE, h: r.h } : { x: r.x, y: pos, w: r.w, h: HANDLE }, label: `Resize ${titleOf(x.n)} and ${titleOf(n.c[i + 1].n)}` });
        pos += HANDLE;
      }
    });
    void cross;
  };
  walk(layout.root, { x: 0, y: 0, w: Math.max(0, W), h: Math.max(0, H) }, []);
  return { rects, handles };
}
const getAt = (n, path) => path.reduce((x, i) => x.c[i].n, n);
function setAt(n, path, fn) { if (!path.length) return fn(n); return { ...n, c: n.c.map((x, i) => (i === path[0] ? { ...x, n: setAt(x.n, path.slice(1), fn) } : x)) }; }

// Moves a divider by `delta` px (positive = right/down), relative to the sizes captured when the drag began.
export function dragHandle(layout, handle, delta) {
  const { index: i, sizes, mins, path } = handle, a = sizes[i], b = sizes[i + 1];
  const na = clamp(a + delta, mins[i], Math.max(mins[i], a + b - mins[i + 1]));
  const next = sizes.slice(); next[i] = na; next[i + 1] = a + b - na;
  return { ...layout, root: setAt(layout.root, path, (s) => ({ ...s, c: s.c.map((x, k) => ({ ...x, w: next[k] })) })) };
}
export function equalizeHandle(layout, handle) {
  const { index: i, sizes, path } = handle, avg = (sizes[i] + sizes[i + 1]) / 2, next = sizes.slice(); next[i] = avg; next[i + 1] = avg;
  return { ...layout, root: setAt(layout.root, path, (s) => ({ ...s, c: s.c.map((x, k) => ({ ...x, w: next[k] })) })) };
}

// ---------- moving panes
const DIR = { left: ['row', true], right: ['row', false], top: ['col', true], bottom: ['col', false] }; // [split direction, new pane goes first]
const FRACTION = 0.4; // share of the target a newly split-in pane receives

function insertBeside(root, target, pane, zone) {
  const [d, first] = DIR[zone];
  const wrap = (leaf, w) => ({ t: 'split', d, c: first ? [{ n: P(pane), w: FRACTION * w }, { n: leaf, w: (1 - FRACTION) * w }] : [{ n: leaf, w: (1 - FRACTION) * w }, { n: P(pane), w: FRACTION * w }] });
  const visit = (n) => {
    if (!isSplit(n)) return n;
    const i = n.c.findIndex((x) => !isSplit(x.n) && x.n.p === target);
    if (i >= 0) {
      const w = n.c[i].w;
      if (n.d === d) { const slots = first ? [{ n: P(pane), w: FRACTION * w }, { n: n.c[i].n, w: (1 - FRACTION) * w }] : [{ n: n.c[i].n, w: (1 - FRACTION) * w }, { n: P(pane), w: FRACTION * w }]; return { ...n, c: [...n.c.slice(0, i), ...slots, ...n.c.slice(i + 1)] }; }
      return { ...n, c: n.c.map((x, k) => (k === i ? { n: wrap(x.n, 1), w } : x)) };
    }
    return { ...n, c: n.c.map((x) => ({ ...x, n: visit(x.n) })) };
  };
  return isSplit(root) ? visit(root) : wrap(root, 1);
}
function insertAtEdge(root, pane, edge, frac) {
  const [d, first] = DIR[edge];
  if (isSplit(root) && root.d === d) { const add = (totalW(root) * frac) / (1 - frac); return { ...root, c: first ? [{ n: P(pane), w: add }, ...root.c] : [...root.c, { n: P(pane), w: add }] }; }
  return { t: 'split', d, c: first ? [{ n: P(pane), w: frac }, { n: root, w: 1 - frac }] : [{ n: root, w: 1 - frac }, { n: P(pane), w: frac }] };
}
export const ROOT = '@root';
// Drop `pane` on `target` (another pane, or ROOT for the window edge). zone: left | right | top | bottom | center (swap).
export function movePane(layout, pane, target, zone) {
  if (!PANES.includes(pane) || pane === target) return layout;
  const vis = visiblePanes(layout);
  if (zone === 'center') {
    if (target === ROOT || !vis.includes(target) || !vis.includes(pane)) return layout;
    const swap = (n) => (isSplit(n) ? { ...n, c: n.c.map((x) => ({ ...x, n: swap(x.n) })) } : P(n.p === pane ? target : n.p === target ? pane : n.p));
    return { ...layout, root: swap(layout.root) };
  }
  if (!DIR[zone]) return layout;
  const rest = without(layout.root, pane);
  const base = rest ? tidy(rest) : null;
  let root;
  if (!base) return layout;                                    // moving the only pane: nothing to do
  if (target === ROOT) root = insertAtEdge(base, pane, zone, zone === 'left' || zone === 'right' ? 0.25 : 0.3);
  else { if (!visiblePanes({ root: base }).includes(target)) return layout; root = insertBeside(base, target, pane, zone); }
  return { ...layout, root: tidy(root), hidden: layout.hidden.filter((p) => p !== pane) };
}
export const movePaneToEdge = (layout, pane, edge) => movePane(layout, pane, ROOT, edge);

export function hidePane(layout, pane) {
  if (!HIDEABLE.includes(pane) || !visiblePanes(layout).includes(pane)) return layout;
  const rest = without(layout.root, pane);
  return rest ? { ...layout, root: tidy(rest), hidden: [...layout.hidden, pane] } : layout;
}
// Where a pane returns to when shown again.
export function showPane(layout, pane) {
  if (visiblePanes(layout).includes(pane)) return layout;
  const l = { ...layout, hidden: layout.hidden.filter((p) => p !== pane) }, vis = visiblePanes(l);
  const add = (target, zone) => ({ ...l, root: tidy(insertBeside(l.root, target, pane, zone)) });
  if (pane === 'sessions' && vis.includes('explorer')) return add('explorer', 'bottom');
  if (pane === 'explorer' && vis.includes('sessions')) return add('sessions', 'top');
  if (pane === 'terminal' && vis.includes('editor')) return add('editor', 'bottom');
  if ((pane === 'status' || pane === 'contact') && vis.includes('chat')) return add('chat', 'bottom');
  return { ...l, root: tidy(insertAtEdge(l.root, pane, pane === 'chat' || pane === 'status' || pane === 'contact' ? 'right' : pane === 'terminal' ? 'bottom' : 'left', pane === 'chat' || pane === 'terminal' ? 0.3 : 0.2)) };
}

// ---------- drag and drop zones
const EDGE = 0.25;
// Which part of a pane (rect, in the same coordinates as x/y) is the pointer over?
export function zoneAt(rect, x, y) {
  if (![x, y, rect.w, rect.h].every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) return 'center'; // no usable pointer position
  const fx = (x - rect.x) / rect.w, fy = (y - rect.y) / rect.h;
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy }, m = Math.min(...Object.values(d));
  if (m > EDGE) return 'center';
  return Object.entries(d).find(([, v]) => v === m)[0];
}
export function previewRect(rect, zone) {
  if (zone === 'center') return rect;
  const f = zone === 'left' || zone === 'right' ? { w: rect.w * 0.5 } : { h: rect.h * 0.5 };
  if (zone === 'left') return { ...rect, ...f };
  if (zone === 'right') return { ...rect, x: rect.x + rect.w - f.w, ...f };
  if (zone === 'top') return { ...rect, ...f };
  return { ...rect, y: rect.y + rect.h - f.h, ...f };
}
