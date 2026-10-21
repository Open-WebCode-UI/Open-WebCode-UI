import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_LAYOUT, PRESETS, PANES, PANE_TITLES, HIDEABLE, ROOT, HANDLE, normalizeLayout, loadLayout, saveLayout, visiblePanes, leaves, computeRects, dragHandle, equalizeHandle, movePane, movePaneToEdge, hidePane, showPane, applyPreset, resetLayout, zoneAt, previewRect } from '../src/components/ide/layout.js';

const W = 1400, H = 800;
const rects = (l, w = W, h = H) => computeRects(l, w, h);
const overlap = (a, b) => a && b && a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;
function expectTiling(l, w = W, h = H) {
  const { rects: r } = rects(l, w, h), vis = PANES.filter((p) => r[p]);
  expect(vis.sort()).toEqual(visiblePanes(l).sort());
  for (const p of vis) { expect(r[p].x).toBeGreaterThanOrEqual(-0.01); expect(r[p].y).toBeGreaterThanOrEqual(-0.01); expect(r[p].x + r[p].w).toBeLessThanOrEqual(w + 0.01); expect(r[p].y + r[p].h).toBeLessThanOrEqual(h + 0.01); expect(r[p].w).toBeGreaterThan(0); expect(r[p].h).toBeGreaterThan(0); }
  for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) expect(overlap(r[vis[i]], r[vis[j]]), `${vis[i]} vs ${vis[j]}`).toBe(false);
}
const isSane = (n) => n.t === 'pane' ? PANES.includes(n.p) : (n.c.length >= 2 && n.c.every((x) => x.w > 0 && isSane(x.n) && !(x.n.t === 'split' && x.n.d === n.d)));

describe('names', () => {
  it('every pane has a name, the editor included', () => {
    expect(PANE_TITLES).toEqual({ explorer: 'Explorer', sessions: 'Sessions', editor: 'Editor', terminal: 'Terminal', chat: 'Agent', status: 'Platform status', contact: 'Contact' });
    for (const p of PANES) expect(PANE_TITLES[p]).toBeTruthy(); expect(HIDEABLE).not.toContain('editor');
  });
});

describe('default layout and geometry', () => {
  it('tiles the window with no gaps or overlaps', () => {
    expectTiling(DEFAULT_LAYOUT); const r = rects(DEFAULT_LAYOUT).rects;
    expect(r.explorer.x).toBe(0); expect(r.explorer.y).toBeLessThan(r.sessions.y); expect(r.editor.x).toBeGreaterThan(r.explorer.x + r.explorer.w - 1);
    expect(r.terminal.y).toBeGreaterThan(r.editor.y); expect(r.chat.x + r.chat.w).toBeCloseTo(W, 3); expect(r.chat.x).toBeGreaterThan(r.editor.x + r.editor.w - 1);
  });
  it.each(Object.keys(PRESETS))('preset %s is valid, complete, and tiles the window', (k) => {
    const l = applyPreset(DEFAULT_LAYOUT, k); expect(isSane(l.root)).toBe(true); expect(visiblePanes(l)).toContain('editor'); expectTiling(l);
    expect([...visiblePanes(l), ...l.hidden].sort()).toEqual([...PANES].sort());
  });
  it('"chat and terminal at the bottom" puts them side by side under the editor; "chat on the left" moves it first', () => {
    let r = rects(applyPreset(DEFAULT_LAYOUT, 'chatBottom')).rects; expect(r.chat.y).toBeCloseTo(r.terminal.y, 3); expect(r.chat.y).toBeGreaterThan(r.editor.y); expect(r.chat.x).toBeLessThan(r.terminal.x);
    r = rects(applyPreset(DEFAULT_LAYOUT, 'chatLeft')).rects; expect(r.chat.x).toBe(0);
    expect(rects(applyPreset(DEFAULT_LAYOUT, 'focus')).rects.editor).toEqual({ x: 0, y: 0, w: W, h: H });
  });
  it('keeps every pane above its minimum size, even in a small window', () => {
    for (const [w, h] of [[1000, 600], [800, 500]]) { expectTiling(DEFAULT_LAYOUT, w, h); const r = rects(DEFAULT_LAYOUT, w, h).rects; expect(r.editor.w).toBeGreaterThanOrEqual(255); expect(r.chat.w).toBeGreaterThanOrEqual(235); }
    expect(() => rects(DEFAULT_LAYOUT, 0, 0)).not.toThrow(); // jsdom-style zero size
  });
  it('shares space by weight', () => {
    const l = normalizeLayout({ v: 2, hidden: ['explorer', 'sessions', 'terminal'], root: { t: 'split', d: 'row', c: [{ n: { t: 'pane', p: 'editor' }, w: 3 }, { n: { t: 'pane', p: 'chat' }, w: 1 }] } });
    const r = rects(l).rects; expect(r.editor.w / r.chat.w).toBeCloseTo(3, 1);
  });
});

describe('persistence and repair', () => {
  beforeEach(() => localStorage.clear());
  it('round-trips and survives corrupt or unavailable storage', () => {
    const l = movePane(DEFAULT_LAYOUT, 'chat', 'editor', 'bottom'); saveLayout(l); expect(loadLayout()).toEqual(l);
    localStorage.setItem('ide-layout-v2', '{oops'); expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
    const orig = Storage.prototype.getItem; Storage.prototype.getItem = () => { throw new Error('blocked'); }; expect(loadLayout()).toEqual(DEFAULT_LAYOUT); Storage.prototype.getItem = orig;
  });
  it('repairs bad data: unknown panes, duplicates, missing editor, junk weights, wrong shapes', () => {
    expect(normalizeLayout('x')).toEqual(DEFAULT_LAYOUT); expect(normalizeLayout({ v: 2, root: { t: 'weird' } })).toEqual(DEFAULT_LAYOUT);
    const l = normalizeLayout({ v: 2, hidden: ['editor', 'nope', 'chat'], root: { t: 'split', d: 'row', c: [{ n: { t: 'pane', p: 'chat' }, w: -5 }, { n: { t: 'pane', p: 'chat' }, w: NaN }, { n: { t: 'pane', p: 'ghost' }, w: 1 }, { n: { t: 'pane', p: 'terminal' }, w: 'x' }] } });
    expect(visiblePanes(l)).toContain('editor'); expect(new Set(visiblePanes(l)).size).toBe(visiblePanes(l).length); expect(isSane(l.root)).toBe(true); expect(l.hidden).not.toContain('editor');
    expect([...visiblePanes(l), ...l.hidden].sort()).toEqual([...PANES].sort()); expectTiling(l);
  });
  it('reads a layout saved by the previous version (docks) and keeps its arrangement', () => {
    localStorage.setItem('ide-layout-v1', JSON.stringify({ docks: { explorer: 'right', chat: 'bottom', terminal: 'hidden' }, sizes: { left: 300, right: 300, bottom: 300 } }));
    const l = loadLayout(); expect(l.hidden).toEqual(expect.arrayContaining(['terminal', 'sessions'])); const r = rects(l).rects;
    expect(r.explorer.x).toBeGreaterThan(r.editor.x); expect(r.chat.y).toBeGreaterThan(r.editor.y); expectTiling(l);
  });
  it('a pane the stored layout never knew about (e.g. Sessions) is added back', () => {
    const l = normalizeLayout({ v: 2, hidden: [], root: { t: 'split', d: 'row', c: [{ n: { t: 'pane', p: 'explorer' }, w: 1 }, { n: { t: 'pane', p: 'editor' }, w: 3 }, { n: { t: 'pane', p: 'chat' }, w: 1 }, { n: { t: 'pane', p: 'terminal' }, w: 1 }] } });
    expect(visiblePanes(l)).toContain('sessions'); expectTiling(l);
  });
});

describe('moving panes (drag and drop)', () => {
  it('dropping on the edge of a pane splits it: the new pane lands on that side', () => {
    for (const [zone, check] of [['left', (a, b) => a.x < b.x], ['right', (a, b) => a.x > b.x], ['top', (a, b) => a.y < b.y], ['bottom', (a, b) => a.y > b.y]]) {
      const l = movePane(DEFAULT_LAYOUT, 'terminal', 'chat', zone); expectTiling(l); expect(isSane(l.root), zone).toBe(true);
      const r = rects(l).rects; expect(check(r.terminal, r.chat), zone).toBe(true);
      if (zone === 'left' || zone === 'right') expect(r.terminal.y).toBeCloseTo(r.chat.y, 3); else expect(r.terminal.x).toBeCloseTo(r.chat.x, 3); // sharing the target's space
    }
  });
  it('splitting within a split inserts a sibling instead of nesting', () => {
    const l = movePane(DEFAULT_LAYOUT, 'chat', 'terminal', 'right'); // terminal sits in a column with the editor; "right" must start a row
    const r = rects(l).rects; expect(r.chat.x).toBeGreaterThan(r.terminal.x); expect(r.chat.y).toBeCloseTo(r.terminal.y, 3); expect(isSane(l.root)).toBe(true);
    const m = movePane(DEFAULT_LAYOUT, 'sessions', 'explorer', 'top'); expect(rects(m).rects.sessions.y).toBe(0); expect(m.root.c[0].n.c).toHaveLength(2); // same direction as the existing column
  });
  it('the editor can be moved like any other pane, and a pane can take the editor\'s place', () => {
    const l = movePane(DEFAULT_LAYOUT, 'editor', 'chat', 'right'); expectTiling(l); const r = rects(l).rects; expect(r.editor.x).toBeGreaterThan(r.chat.x);
    expect(visiblePanes(l)).toContain('editor'); expect(movePane(l, 'chat', 'editor', 'center')).not.toEqual(l);
  });
  it('dropping on the middle swaps two panes', () => {
    const l = movePane(DEFAULT_LAYOUT, 'chat', 'editor', 'center'); const a = rects(DEFAULT_LAYOUT).rects, b = rects(l).rects;
    expect(b.chat.x).toBeCloseTo(a.editor.x, 3); expect(b.chat.y).toBeCloseTo(a.editor.y, 3); expect(b.editor.x).toBeCloseTo(a.chat.x, 3); expectTiling(l);
  });
  it('dropping on a window edge docks the pane along the whole side', () => {
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      const l = movePaneToEdge(DEFAULT_LAYOUT, 'terminal', edge); expectTiling(l); const r = rects(l).rects;
      if (edge === 'left') { expect(r.terminal.x).toBe(0); expect(r.terminal.h).toBeCloseTo(H, 3); } if (edge === 'right') { expect(r.terminal.x + r.terminal.w).toBeCloseTo(W, 3); expect(r.terminal.h).toBeCloseTo(H, 3); }
      if (edge === 'top') { expect(r.terminal.y).toBe(0); expect(r.terminal.w).toBeCloseTo(W, 3); } if (edge === 'bottom') { expect(r.terminal.y + r.terminal.h).toBeCloseTo(H, 3); expect(r.terminal.w).toBeCloseTo(W, 3); }
    }
    expect(movePane(DEFAULT_LAYOUT, 'chat', ROOT, 'center')).toBe(DEFAULT_LAYOUT);
  });
  it('removing a pane collapses the splits it leaves behind (no empty or single-child splits)', () => {
    let l = DEFAULT_LAYOUT; for (const p of ['explorer', 'sessions', 'terminal', 'chat']) l = hidePane(l, p);
    expect(l.root).toEqual({ t: 'pane', p: 'editor' }); expect(l.hidden.sort()).toEqual(['chat', 'contact', 'explorer', 'sessions', 'status', 'terminal']);
    expect(isSane(movePane(DEFAULT_LAYOUT, 'explorer', 'chat', 'bottom').root)).toBe(true);
  });
  it('ignores impossible moves', () => {
    expect(movePane(DEFAULT_LAYOUT, 'chat', 'chat', 'left')).toBe(DEFAULT_LAYOUT); expect(movePane(DEFAULT_LAYOUT, 'nope', 'chat', 'left')).toBe(DEFAULT_LAYOUT);
    expect(movePane(DEFAULT_LAYOUT, 'chat', 'nope', 'left')).toBe(DEFAULT_LAYOUT); expect(movePane(DEFAULT_LAYOUT, 'chat', 'editor', 'diagonal')).toBe(DEFAULT_LAYOUT);
    const hidden = hidePane(DEFAULT_LAYOUT, 'terminal'); expect(movePane(hidden, 'chat', 'terminal', 'left')).toBe(hidden); // target is not on screen
  });
  it('moving never loses or duplicates a pane, whatever the sequence', () => {
    let seed = 7; const rnd = (n) => { seed = (seed * 16807) % 2147483647; return seed % n; };
    let l = DEFAULT_LAYOUT; const zones = ['left', 'right', 'top', 'bottom', 'center'];
    for (let i = 0; i < 300; i++) {
      const vis = visiblePanes(l), p = PANES[rnd(PANES.length)];
      if (rnd(6) === 0 && HIDEABLE.includes(p)) l = vis.includes(p) ? hidePane(l, p) : showPane(l, p);
      else if (vis.includes(p) || l.hidden.includes(p)) l = movePane(l, p, rnd(5) === 0 ? ROOT : vis[rnd(vis.length)], zones[rnd(5)]);
      expect(isSane(l.root)).toBe(true); expect(new Set(leaves(l.root)).size).toBe(leaves(l.root).length); expect(visiblePanes(l)).toContain('editor');
      expect([...visiblePanes(l), ...l.hidden].sort()).toEqual([...PANES].sort()); expectTiling(l);
    }
  });
});

describe('hide and show', () => {
  it('the editor cannot be hidden; other panes return to a sensible place', () => {
    expect(hidePane(DEFAULT_LAYOUT, 'editor')).toBe(DEFAULT_LAYOUT);
    for (const p of HIDEABLE) { const back = showPane(hidePane(DEFAULT_LAYOUT, p), p); expectTiling(back); expect(visiblePanes(back)).toContain(p); expect(back.hidden).toEqual(['status', 'contact'].filter((h) => h !== p)); }
    const r = rects(showPane(hidePane(DEFAULT_LAYOUT, 'terminal'), 'terminal')).rects; expect(r.terminal.y).toBeGreaterThan(r.editor.y);
    const s = rects(showPane(hidePane(DEFAULT_LAYOUT, 'sessions'), 'sessions')).rects; expect(s.sessions.y).toBeGreaterThan(s.explorer.y);
    expect(showPane(DEFAULT_LAYOUT, 'chat')).toBe(DEFAULT_LAYOUT);
  });
  it('sessions return even when the explorer is hidden', () => { const l = showPane(hidePane(hidePane(DEFAULT_LAYOUT, 'explorer'), 'sessions'), 'sessions'); expectTiling(l); expect(visiblePanes(l)).toContain('sessions'); });
  it('reset restores the default', () => { expect(resetLayout()).toEqual(DEFAULT_LAYOUT); });
});

describe('resizing', () => {
  const handle = (l, id) => rects(l).handles.find((h) => h.id === id);
  it('a divider moves space between its two neighbors only', () => {
    const h = rects(DEFAULT_LAYOUT).handles.find((x) => x.label === 'Resize Explorer and Editor'); expect(h.orientation).toBe('vertical');
    const before = rects(DEFAULT_LAYOUT).rects, after = rects(dragHandle(DEFAULT_LAYOUT, h, 80)).rects;
    expect(after.explorer.w).toBeCloseTo(before.explorer.w + 80, 3); expect(after.editor.w).toBeCloseTo(before.editor.w - 80, 3); expect(after.chat.w).toBeCloseTo(before.chat.w, 3);
  });
  it('vertical stacks resize vertically, and nested splits are independent', () => {
    const h = rects(DEFAULT_LAYOUT).handles.find((x) => x.label === 'Resize Editor and Terminal'); expect(h.orientation).toBe('horizontal');
    const before = rects(DEFAULT_LAYOUT).rects, after = rects(dragHandle(DEFAULT_LAYOUT, h, -100)).rects;
    expect(after.terminal.h).toBeCloseTo(before.terminal.h + 100, 3); expect(after.explorer.h).toBeCloseTo(before.explorer.h, 3);
  });
  it('never squeezes a pane below its minimum, in either direction', () => {
    const h = rects(DEFAULT_LAYOUT).handles.find((x) => x.label === 'Resize Editor and Chat' || x.label === 'Resize Editor and Agent');
    const left = rects(dragHandle(DEFAULT_LAYOUT, h, -99999)).rects, right = rects(dragHandle(DEFAULT_LAYOUT, h, 99999)).rects;
    expect(left.editor.w).toBeGreaterThanOrEqual(259); expect(right.chat.w).toBeGreaterThanOrEqual(239); expectTiling(dragHandle(DEFAULT_LAYOUT, h, 99999));
  });
  it('equalizing a divider splits the pair evenly', () => {
    const h = rects(DEFAULT_LAYOUT).handles.find((x) => x.label === 'Resize Explorer and Sessions'); const r = rects(equalizeHandle(DEFAULT_LAYOUT, h)).rects;
    expect(r.explorer.h).toBeCloseTo(r.sessions.h, 3);
  });
  it('divider labels name the panes either side', () => { expect(rects(DEFAULT_LAYOUT).handles.map((h) => h.label).sort()).toEqual(['Resize Editor and Agent', 'Resize Editor and Terminal', 'Resize Explorer and Editor', 'Resize Explorer and Sessions']); });
  it('handles occupy the gap between panes', () => { const r = rects(DEFAULT_LAYOUT); for (const h of r.handles) expect(h.orientation === 'vertical' ? h.rect.w : h.rect.h).toBe(HANDLE); });
});

describe('drop zones', () => {
  const rect = { x: 100, y: 100, w: 400, h: 300 };
  it('edges split, the middle swaps', () => {
    expect(zoneAt(rect, 110, 250)).toBe('left'); expect(zoneAt(rect, 490, 250)).toBe('right'); expect(zoneAt(rect, 300, 110)).toBe('top'); expect(zoneAt(rect, 300, 390)).toBe('bottom'); expect(zoneAt(rect, 300, 250)).toBe('center');
  });
  it('falls back to a swap when the pointer position is unknown', () => { expect(zoneAt(rect, undefined, undefined)).toBe('center'); expect(zoneAt({ x: 0, y: 0, w: 0, h: 0 }, 1, 1)).toBe('center'); });
  it('corners pick the nearest edge', () => { expect(zoneAt(rect, 105, 120)).toBe('left'); expect(zoneAt(rect, 120, 105)).toBe('top'); });
  it('the preview covers the half that the pane would claim', () => {
    expect(previewRect(rect, 'left')).toEqual({ x: 100, y: 100, w: 200, h: 300 }); expect(previewRect(rect, 'right')).toEqual({ x: 300, y: 100, w: 200, h: 300 });
    expect(previewRect(rect, 'top')).toEqual({ x: 100, y: 100, w: 400, h: 150 }); expect(previewRect(rect, 'bottom')).toEqual({ x: 100, y: 250, w: 400, h: 150 }); expect(previewRect(rect, 'center')).toEqual(rect);
  });
});

describe('default layout when shell access is off', async () => {
  const { layoutStore } = await import('../src/layoutStore.js');
  const { visiblePanes } = await import('../src/components/ide/layout.js');
  it('hides the terminal for a user with no saved layout, and keeps it for one who has a saved layout', () => {
    localStorage.clear(); layoutStore.forgetForTests(); layoutStore.configure({ shellEnabled: false });
    expect(visiblePanes(layoutStore.get())).not.toContain('terminal');
    layoutStore.toggle('terminal'); expect(visiblePanes(layoutStore.get())).toContain('terminal'); // can still be shown
    layoutStore.reset(); expect(visiblePanes(layoutStore.get())).not.toContain('terminal');
    layoutStore.forgetForTests(); layoutStore.configure({ shellEnabled: false });
    localStorage.setItem('ide-layout-v2', JSON.stringify(DEFAULT_LAYOUT)); expect(visiblePanes(layoutStore.get())).toContain('terminal'); // a saved layout is respected
    localStorage.clear(); layoutStore.forgetForTests(); layoutStore.configure({ shellEnabled: true });
    expect(visiblePanes(layoutStore.get())).toContain('terminal');
  });
});
