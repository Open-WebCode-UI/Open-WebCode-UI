import { describe, it, expect, vi, afterEach } from 'vitest';
import { changedRegion, changeKind, showLiveDiff, clearLiveDiff } from '../src/components/ide/liveDiff.js';

describe('changedRegion', () => {
  it('returns null when nothing changed', () => {
    expect(changedRegion('a\nb', 'a\nb')).toBeNull();
  });
  it('finds a replaced line and the line it removed', () => {
    expect(changedRegion('a\nb\nc', 'a\nX\nc')).toEqual({ start: 1, end: 2, removed: ['b'] });
  });
  it('finds appended lines (a streamed file growing at the end)', () => {
    expect(changedRegion('a\nb', 'a\nb\nc\nd')).toEqual({ start: 2, end: 4, removed: [] });
  });
  it('finds a pure deletion as an empty added range', () => {
    expect(changedRegion('a\nb\nc', 'a\nc')).toEqual({ start: 1, end: 1, removed: ['b'] });
  });
  it('reports a multi-line replacement from the first differing line', () => {
    expect(changedRegion('x\nold1\nold2\ny', 'x\nnew1\nnew2\nnew3\ny')).toEqual({ start: 1, end: 4, removed: ['old1', 'old2'] });
  });
  it('treats an empty before-text as all lines added', () => {
    expect(changedRegion('', 'a\nb')).toEqual({ start: 0, end: 2, removed: [''] });
  });
});

describe('showLiveDiff / clearLiveDiff', () => {
  afterEach(() => { vi.useRealTimers(); });

  function fakeEditor(lines) {
    const zones = new Map(); let zid = 0; const sets = [];
    return {
      zones, sets,
      getModel: () => ({ getLineCount: () => lines }),
      getOption: (opt) => (opt === 'fontInfo' ? { fontFamily: 'Menlo, monospace', fontSize: 14 } : 20),
      createDecorationsCollection: (d) => { sets.push(d); return { clear: vi.fn() }; },
      changeViewZones: (fn) => fn({ addZone: (z) => { const id = ++zid; zones.set(id, z); return id; }, removeZone: (id) => zones.delete(id) }),
    };
  }
  const monaco = { Range: class { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } }, editor: { EditorOption: { lineHeight: 67, fontInfo: 'fontInfo' } } };

  it('classifies a change as add, delete or edit', () => {
    expect(changeKind({ start: 0, end: 2, removed: [] })).toBe('add');
    expect(changeKind({ start: 1, end: 1, removed: ['b'] })).toBe('delete');
    expect(changeKind({ start: 1, end: 3, removed: ['old'] })).toBe('edit');
  });

  it('paints an addition green, with no removed block', () => {
    const ed = fakeEditor(5); const L = {};
    showLiveDiff(ed, monaco, { start: 2, end: 4, removed: [] }, L);
    expect(ed.sets[0][0].options.className).toBe('agent-diff-add');
    expect(ed.zones.size).toBe(0);
  });

  it('paints a deletion red: a red block of the removed lines and a red marker', () => {
    const ed = fakeEditor(5); const L = {};
    showLiveDiff(ed, monaco, { start: 1, end: 1, removed: ['b'] }, L);
    expect(ed.sets[0][0].options.className).toBe('agent-diff-del-line');
    const zone = [...ed.zones.values()][0];
    expect(zone.domNode.className).toBe('agent-diff-block-delete');
  });

  it('paints an edit amber: the new lines and the replaced block', () => {
    vi.useFakeTimers();
    const ed = fakeEditor(5); const L = {};
    showLiveDiff(ed, monaco, { start: 1, end: 3, removed: ['old'] }, L);
    expect(ed.sets[0][0].options.className).toBe('agent-diff-edit');
    expect([...ed.zones.values()][0].domNode.className).toBe('agent-diff-block-edit');
    vi.useRealTimers();
  });

  it('paints a replaced block then fades it out', () => {
    vi.useFakeTimers();
    const ed = fakeEditor(5); const L = {};
    showLiveDiff(ed, monaco, { start: 1, end: 3, removed: ['old'] }, L);
    expect(ed.sets[0][0].options.className).toBe('agent-diff-edit');
    expect(ed.sets[0][0].range).toMatchObject({ a: 2, c: 3 });
    const zone = [...ed.zones.values()][0];
    expect(zone).toMatchObject({ afterLineNumber: 1, heightInPx: 20 });
    expect(zone.domNode.style.fontFamily).toBe('Menlo, monospace');
    expect(zone.domNode.style.fontSize).toBe('14px');
    vi.advanceTimersByTime(2000);
    expect(ed.zones.size).toBe(0);
    expect(L.zone).toBeUndefined();
  });

  it('a new change replaces the previous highlight instead of stacking', () => {
    const ed = fakeEditor(5); const L = {};
    showLiveDiff(ed, monaco, { start: 0, end: 1, removed: [] }, L);
    const first = ed.sets.length;
    showLiveDiff(ed, monaco, { start: 2, end: 3, removed: ['x'] }, L);
    expect(ed.sets.length).toBe(first + 1);
    expect(ed.zones.size).toBe(1);
    clearLiveDiff(ed, L);
    expect(ed.zones.size).toBe(0);
  });

  it('is a no-op on an editor without a model', () => {
    const L = {};
    expect(() => showLiveDiff({}, monaco, { start: 0, end: 1, removed: [] }, L)).not.toThrow();
  });
});
