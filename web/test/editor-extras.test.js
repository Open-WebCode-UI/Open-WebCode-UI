import { describe, it, expect, vi } from 'vitest';
import { csvSpans } from '../src/components/ide/csvRainbow.js';
import { toggleBreakpoint, toggleAtCursor } from '../src/components/ide/debug.js';
import { EDITOR_THEMES, EDITOR_THEME_IDS, isDarkEditorTheme, defineEditorThemes } from '../src/components/ide/editorThemes.js';
import { normalizePrefs, monacoOptions, DEFAULT_PREFS } from '../src/components/ide/editorPrefs.js';
import { shortcut } from '../src/components/ide/editorActions.js';

describe('csvSpans (Rainbow CSV columns)', () => {
  it('splits fields with their column index and keeps quoted commas inside one field', () => {
    expect(csvSpans('a,"b,c",d\n1,2')).toEqual([{ start: 0, end: 1, col: 0 }, { start: 2, end: 7, col: 1 }, { start: 8, end: 9, col: 2 }, { start: 10, end: 11, col: 0 }, { start: 12, end: 13, col: 1 }]);
  });
  it('treats doubled quotes inside a quoted field as one field, and CRLF as one line break', () => {
    expect(csvSpans('x,"a""b"')).toEqual([{ start: 0, end: 1, col: 0 }, { start: 2, end: 8, col: 1 }]);
    expect(csvSpans('a\r\nb')).toEqual([{ start: 0, end: 1, col: 0 }, { start: 3, end: 4, col: 0 }]);
  });
  it('gives empty text no fields', () => { expect(csvSpans('')).toEqual([]); });
});

describe('breakpoints', () => {
  const monaco = { Range: function Range(a, b, c, d) { Object.assign(this, { startLineNumber: a, startColumn: b, endLineNumber: c, endColumn: d }); } };
  it('adds a breakpoint to a line with no decoration yet, then removes it on the next toggle', () => {
    let existing = [];
    const model = { getLineDecorations: vi.fn(() => existing), deltaDecorations: vi.fn(() => []) };
    const ed = { getModel: () => model, getPosition: () => ({ lineNumber: 3, column: 1 }) };
    expect(toggleAtCursor(ed, monaco)).toBe(true);
    expect(model.deltaDecorations).toHaveBeenLastCalledWith([], [expect.objectContaining({ range: expect.objectContaining({ startLineNumber: 3 }), options: expect.objectContaining({ glyphMarginClassName: 'ide-breakpoint' }) })]);
    existing = [{ id: 'bp1', options: { glyphMarginClassName: 'ide-breakpoint' } }];
    expect(toggleBreakpoint(ed, monaco, 3)).toBe(false);
    expect(model.deltaDecorations).toHaveBeenLastCalledWith(['bp1'], []);
  });
  it('ignores other decorations on the line', () => {
    const model = { getLineDecorations: () => [{ id: 'x', options: { inlineClassName: 'other' } }], deltaDecorations: vi.fn(() => []) };
    expect(toggleBreakpoint({ getModel: () => model }, monaco, 1)).toBe(true);
    expect(model.deltaDecorations.mock.calls[0][0]).toEqual([]);
  });
});

describe('color modes and preferences', () => {
  it('lists the four added modes after the built-in three, and knows which are dark', () => {
    expect(EDITOR_THEME_IDS.slice(0, 2)).toEqual(['vs', 'vs-dark']);
    const labels = EDITOR_THEMES.slice(2).map((t) => t.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    expect(EDITOR_THEME_IDS).toHaveLength(24);
    expect(isDarkEditorTheme('cobalt')).toBe(true); expect(isDarkEditorTheme('grass')).toBe(false); expect(isDarkEditorTheme('')).toBe(false);
    expect(EDITOR_THEMES.length).toBe(24);
  });
  it('registers the custom themes with Monaco', () => {
    const monaco = { editor: { defineTheme: vi.fn() } };
    defineEditorThemes(monaco);
    expect(monaco.editor.defineTheme.mock.calls.map((c) => c[0])).toEqual(['mocha', 'cobalt', 'midnight', 'grass', 'homebrew', 'man-page', 'novel', 'ocean', 'red-sands', 'silver-aerogel', 'barbie', 'dracula', 'solar-light', 'solar-dark', 'panda', 'positron', 'selenized', 'skeletor', 'tokyo', 'dreamweaver', 'eclipse']);
    expect(monaco.editor.defineTheme.mock.calls[0][1]).toMatchObject({ base: 'vs-dark', inherit: true });
  });
  it('keeps known themes and drops unknown ones; the new flags default safely', () => {
    expect(normalizePrefs({ theme: 'mocha' }).theme).toBe('mocha');
    expect(normalizePrefs({ theme: 'neon' }).theme).toBe('');
    expect(normalizePrefs({ rainbowCsv: 'yes' })).toMatchObject({ rainbowCsv: DEFAULT_PREFS.rainbowCsv, altClickCursors: true });
  });
  it('maps the multi-cursor choice and the glyph margin onto Monaco options', () => {
    expect(monacoOptions({ ...DEFAULT_PREFS }, false)).toMatchObject({ multiCursorModifier: 'alt', glyphMargin: false });
    expect(monacoOptions({ ...DEFAULT_PREFS, altClickCursors: false }, false, true)).toMatchObject({ multiCursorModifier: 'ctrlCmd', glyphMargin: true });
  });
  it('writes shortcuts for the platform (Ctrl and + here, since jsdom is not a Mac)', () => {
    expect(shortcut('Mod', 'Shift', 'K')).toBe('Ctrl+Shift+K'); expect(shortcut('Shift', 'Alt', 'F')).toBe('Shift+Alt+F');
  });
});

import { paletteOf, customMonacoTheme, themeIsDark, defineCustomThemes } from '../src/components/ide/editorThemes.js';
describe('user themes (pure helpers)', () => {
  const mine = { id: 'custom-abcd1234', name: 'Mine', dark: false, colors: Object.fromEntries(['editor.background', 'editor.foreground', 'editorLineNumber.foreground', 'editorLineNumber.activeForeground', 'editor.selectionBackground', 'editor.lineHighlightBackground', 'editorCursor.foreground', 'editorWidget.background'].map((k) => [k, '#fafafa'])), tokens: Object.fromEntries(['comment', 'keyword', 'string', 'number', 'type', 'delimiter'].map((k) => [k, '#123456'])) };
  it('starts a new theme from any built-in or custom palette, with every field filled in', () => {
    for (const id of ['vs', 'vs-dark', 'hc-black', 'mocha', 'grass', 'silver-aerogel']) {
      const p = paletteOf(id);
      expect(Object.keys(p.colors)).toHaveLength(8); expect(Object.keys(p.tokens)).toHaveLength(6);
      expect(Object.values(p.tokens).every((v) => /^#[0-9a-f]{6}$/i.test(v))).toBe(true);
    }
    expect(paletteOf('mocha').colors['editor.background']).toBe('#2a211b');
  });
  it('turns a user theme into a Monaco definition: italic comments, colors without the # on token rules', () => {
    const def = customMonacoTheme(mine);
    expect(def).toMatchObject({ base: 'vs', inherit: true, colors: mine.colors });
    expect(def.rules.find((r) => r.token === 'comment')).toEqual({ token: 'comment', foreground: '123456', fontStyle: 'italic' });
    expect(def.rules.find((r) => r.token === 'keyword').foreground).toBe('123456');
  });
  it('defines every user theme in Monaco, and knows whether a custom theme is dark', () => {
    const monaco = { editor: { defineTheme: vi.fn() } };
    defineCustomThemes(monaco, [mine]); expect(monaco.editor.defineTheme).toHaveBeenCalledWith(mine.id, expect.any(Object));
    expect(themeIsDark(mine.id, [mine])).toBe(false); expect(themeIsDark('mocha', [mine])).toBe(true);
  });
});
