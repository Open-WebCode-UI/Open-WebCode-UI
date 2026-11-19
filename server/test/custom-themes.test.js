import { describe, it, expect } from 'vitest';
import { prefSchema, readPreferences, DEFAULT_PREFERENCES } from '../src/preferences.js';

const COLOR_KEYS = ['editor.background', 'editor.foreground', 'editorLineNumber.foreground', 'editorLineNumber.activeForeground', 'editor.selectionBackground', 'editor.lineHighlightBackground', 'editorCursor.foreground', 'editorWidget.background'];
const TOKEN_KEYS = ['comment', 'keyword', 'string', 'number', 'type', 'delimiter'];
const theme = (id = 'custom-abcd1234', over = {}) => ({
  id, name: 'Night owl', dark: true,
  colors: Object.fromEntries(COLOR_KEYS.map((k) => [k, '#101820'])),
  tokens: Object.fromEntries(TOKEN_KEYS.map((k) => [k, '#c3e88d'])),
  ...over,
});
const parse = (customEditorThemes) => prefSchema.safeParse({ ...DEFAULT_PREFERENCES, customEditorThemes });

describe('user editor themes in preferences', () => {
  it('defaults to no custom themes, and a stored list is read back', () => {
    expect(DEFAULT_PREFERENCES.customEditorThemes).toEqual([]);
    expect(readPreferences({ preferences: JSON.stringify({ customEditorThemes: [theme()] }) }).customEditorThemes).toHaveLength(1);
  });
  it('accepts a well-formed theme', () => { expect(parse([theme()]).success).toBe(true); });
  it('rejects a color that is not a 6-digit hex', () => {
    expect(parse([theme('custom-abcd1234', { colors: { ...theme().colors, 'editor.background': 'red' } })]).success).toBe(false);
    expect(parse([theme('custom-abcd1234', { tokens: { ...theme().tokens, keyword: '#fff' } })]).success).toBe(false);
  });
  it('rejects unknown color keys and a missing field', () => {
    expect(parse([theme('custom-abcd1234', { colors: { ...theme().colors, 'editor.evil': '#000000' } })]).success).toBe(false);
    const t = theme(); delete t.tokens.string;
    expect(parse([t]).success).toBe(false);
  });
  it('rejects ids outside the custom- pattern, empty names, and duplicate ids', () => {
    expect(parse([theme('vs-dark')]).success).toBe(false);
    expect(parse([theme('custom-abcd1234', { name: '   ' })]).success).toBe(false);
    expect(parse([theme('custom-abcd1234'), theme('custom-abcd1234')]).success).toBe(false);
  });
  it('limits the list to 20 themes', () => {
    const many = Array.from({ length: 21 }, (_, i) => theme(`custom-aaaa${String(i).padStart(4, '0')}`));
    expect(parse(many).success).toBe(false); expect(parse(many.slice(0, 20)).success).toBe(true);
  });
  it('a partial update may change only the list', () => {
    expect(prefSchema.partial().safeParse({ customEditorThemes: [theme()] }).success).toBe(true);
  });
});
