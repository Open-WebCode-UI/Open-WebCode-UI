// Editor color modes. The four built-in Monaco themes (light, dark, high contrast) are joined by four custom ones defined here.
// This module has no Monaco import so the preferences code can use the list; defineEditorThemes() registers the custom ones
// once, from monacoSetup.js, before any editor is created.

// `dark` decides the palette for the Rainbow CSV colors, which must stay readable on the background.
export const EDITOR_THEMES = [
  // Standard Light and Dark always come first; the rest are alphabetical by label.
  { id: 'vs', label: 'Light', dark: false },
  { id: 'vs-dark', label: 'Dark', dark: true },
  { id: 'barbie', label: 'Barbie', dark: false },
  { id: 'cobalt', label: 'Cobalt', dark: true },
  { id: 'dracula', label: 'Dracula', dark: true },
  { id: 'dreamweaver', label: 'Dreamweaver', dark: false },
  { id: 'eclipse', label: 'Eclipse', dark: false },
  { id: 'grass', label: 'Grass', dark: false },
  { id: 'hc-black', label: 'High contrast', dark: true },
  { id: 'homebrew', label: 'Homebrew', dark: true },
  { id: 'man-page', label: 'Man page', dark: false },
  { id: 'midnight', label: 'Midnight', dark: true },
  { id: 'mocha', label: 'Mocha', dark: true },
  { id: 'novel', label: 'Novel', dark: false },
  { id: 'ocean', label: 'Ocean', dark: true },
  { id: 'panda', label: 'Panda', dark: true },
  { id: 'positron', label: 'Positron', dark: true },
  { id: 'red-sands', label: 'Red sands', dark: true },
  { id: 'selenized', label: 'Selenized', dark: true },
  { id: 'silver-aerogel', label: 'Silver aerogel', dark: false },
  { id: 'skeletor', label: 'Skeletor', dark: true },
  { id: 'solar-dark', label: 'Solar dark', dark: true },
  { id: 'solar-light', label: 'Solar light', dark: false },
  { id: 'tokyo', label: 'Tokyo', dark: true },
];
export const EDITOR_THEME_IDS = EDITOR_THEMES.map((t) => t.id);
export const isDarkEditorTheme = (id) => !!EDITOR_THEMES.find((t) => t.id === id)?.dark;

// Custom palettes. `base` is the built-in theme they extend; `rules` color tokens and `colors` color the editor chrome.
const CUSTOM = {
  mocha: {
    base: 'vs-dark',
    colors: { 'editor.background': '#2a211b', 'editor.foreground': '#e8dccb', 'editorLineNumber.foreground': '#7d6a58', 'editorLineNumber.activeForeground': '#e9c46a',
      'editor.selectionBackground': '#5a4636', 'editor.lineHighlightBackground': '#342920', 'editorCursor.foreground': '#f5c27a', 'editorWidget.background': '#342920' },
    rules: [
      { token: 'comment', foreground: '8a7a68', fontStyle: 'italic' }, { token: 'keyword', foreground: 'e0a458' }, { token: 'string', foreground: 'a8c686' },
      { token: 'number', foreground: 'd98b6b' }, { token: 'type', foreground: 'f2d28b' }, { token: 'delimiter', foreground: 'bfae98' },
    ],
  },
  cobalt: {
    base: 'vs-dark',
    colors: { 'editor.background': '#002240', 'editor.foreground': '#ffffff', 'editorLineNumber.foreground': '#4f7fa8', 'editorLineNumber.activeForeground': '#ffc600',
      'editor.selectionBackground': '#0050a0', 'editor.lineHighlightBackground': '#00304f', 'editorCursor.foreground': '#ffc600', 'editorWidget.background': '#00304f' },
    rules: [
      { token: 'comment', foreground: '0088ff', fontStyle: 'italic' }, { token: 'keyword', foreground: 'ffc600', fontStyle: 'bold' }, { token: 'string', foreground: '3ad900' },
      { token: 'number', foreground: 'ff628c' }, { token: 'type', foreground: '80ffbb' }, { token: 'delimiter', foreground: 'ffffff' },
    ],
  },
  midnight: {
    base: 'vs-dark',
    colors: { 'editor.background': '#0b0e1a', 'editor.foreground': '#c9d1e6', 'editorLineNumber.foreground': '#3f4a6b', 'editorLineNumber.activeForeground': '#7aa2f7',
      'editor.selectionBackground': '#1f2a4d', 'editor.lineHighlightBackground': '#131a2e', 'editorCursor.foreground': '#7aa2f7', 'editorWidget.background': '#131a2e' },
    rules: [
      { token: 'comment', foreground: '565f89', fontStyle: 'italic' }, { token: 'keyword', foreground: '7aa2f7' }, { token: 'string', foreground: '9ece6a' },
      { token: 'number', foreground: 'ff9e64' }, { token: 'type', foreground: '2ac3de' }, { token: 'delimiter', foreground: '89a0c8' },
    ],
  },
  grass: {
    base: 'vs',
    colors: { 'editor.background': '#eef7e6', 'editor.foreground': '#1f3a1a', 'editorLineNumber.foreground': '#8aa67c', 'editorLineNumber.activeForeground': '#2e7d32',
      'editor.selectionBackground': '#c5e1a5', 'editor.lineHighlightBackground': '#e0f0d2', 'editorCursor.foreground': '#2e7d32', 'editorWidget.background': '#e0f0d2' },
    rules: [
      { token: 'comment', foreground: '6b8f5a', fontStyle: 'italic' }, { token: 'keyword', foreground: '2e7d32', fontStyle: 'bold' }, { token: 'string', foreground: '7b5e00' },
      { token: 'number', foreground: 'a1500d' }, { token: 'type', foreground: '00695c' }, { token: 'delimiter', foreground: '3d5a33' },
    ],
  },
  homebrew: {
    base: 'vs-dark',
    colors: { 'editor.background': '#000000', 'editor.foreground': '#33ff00', 'editorLineNumber.foreground': '#1f7a1f', 'editorLineNumber.activeForeground': '#66ff33',
      'editor.selectionBackground': '#1f5c1f', 'editor.lineHighlightBackground': '#0a1f0a', 'editorCursor.foreground': '#33ff00', 'editorWidget.background': '#0a1f0a' },
    rules: [
      { token: 'comment', foreground: '1f8a1f', fontStyle: 'italic' }, { token: 'keyword', foreground: '66ff33', fontStyle: 'bold' }, { token: 'string', foreground: 'b6ff6e' },
      { token: 'number', foreground: 'ccff66' }, { token: 'type', foreground: '66ff99' }, { token: 'delimiter', foreground: '33cc00' },
    ],
  },
  'man-page': {
    base: 'vs',
    colors: { 'editor.background': '#fef49c', 'editor.foreground': '#000000', 'editorLineNumber.foreground': '#8a7f3a', 'editorLineNumber.activeForeground': '#000000',
      'editor.selectionBackground': '#e8d86a', 'editor.lineHighlightBackground': '#f7ea8a', 'editorCursor.foreground': '#000000', 'editorWidget.background': '#f7ea8a' },
    rules: [
      { token: 'comment', foreground: '7a6d1f', fontStyle: 'italic' }, { token: 'keyword', foreground: '000000', fontStyle: 'bold' }, { token: 'string', foreground: '7a1b1b' },
      { token: 'number', foreground: '1d3fa0' }, { token: 'type', foreground: '1d6b3a' }, { token: 'delimiter', foreground: '333300' },
    ],
  },
  novel: {
    base: 'vs',
    colors: { 'editor.background': '#dfdbc3', 'editor.foreground': '#3b2322', 'editorLineNumber.foreground': '#8a7f66', 'editorLineNumber.activeForeground': '#7d2d1e',
      'editor.selectionBackground': '#c4b98f', 'editor.lineHighlightBackground': '#d3cdb0', 'editorCursor.foreground': '#5a2f2b', 'editorWidget.background': '#d3cdb0' },
    rules: [
      { token: 'comment', foreground: '7d6f58', fontStyle: 'italic' }, { token: 'keyword', foreground: '7d2d1e', fontStyle: 'bold' }, { token: 'string', foreground: '4f6b2a' },
      { token: 'number', foreground: '8b5a00' }, { token: 'type', foreground: '2d4f63' }, { token: 'delimiter', foreground: '3b2322' },
    ],
  },
  ocean: {
    base: 'vs-dark',
    colors: { 'editor.background': '#224fbc', 'editor.foreground': '#ffffff', 'editorLineNumber.foreground': '#8fa8e8', 'editorLineNumber.activeForeground': '#ffffff',
      'editor.selectionBackground': '#3a64cc', 'editor.lineHighlightBackground': '#2a5ac8', 'editorCursor.foreground': '#ffffff', 'editorWidget.background': '#2a5ac8' },
    rules: [
      { token: 'comment', foreground: '8fa8e8', fontStyle: 'italic' }, { token: 'keyword', foreground: 'ffffff', fontStyle: 'bold' }, { token: 'string', foreground: '8fe8a8' },
      { token: 'number', foreground: 'ffb86c' }, { token: 'type', foreground: '7fd8ff' }, { token: 'delimiter', foreground: 'dfe7ff' },
    ],
  },
  'red-sands': {
    base: 'vs-dark',
    colors: { 'editor.background': '#7a251e', 'editor.foreground': '#d7c9a7', 'editorLineNumber.foreground': '#b07a5a', 'editorLineNumber.activeForeground': '#ffd28c',
      'editor.selectionBackground': '#a2473c', 'editor.lineHighlightBackground': '#8a2d25', 'editorCursor.foreground': '#ffd28c', 'editorWidget.background': '#8a2d25' },
    rules: [
      { token: 'comment', foreground: 'a0785a', fontStyle: 'italic' }, { token: 'keyword', foreground: 'ffd28c', fontStyle: 'bold' }, { token: 'string', foreground: 'b8d07a' },
      { token: 'number', foreground: 'ffb08a' }, { token: 'type', foreground: 'f2d9a6' }, { token: 'delimiter', foreground: 'd7c9a7' },
    ],
  },
  'silver-aerogel': {
    base: 'vs',
    colors: { 'editor.background': '#d6dae0', 'editor.foreground': '#1e2024', 'editorLineNumber.foreground': '#7c8590', 'editorLineNumber.activeForeground': '#1e2024',
      'editor.selectionBackground': '#b4bcc8', 'editor.lineHighlightBackground': '#c9ced6', 'editorCursor.foreground': '#1e2024', 'editorWidget.background': '#c9ced6' },
    rules: [
      { token: 'comment', foreground: '6b7480', fontStyle: 'italic' }, { token: 'keyword', foreground: '2c3e6b', fontStyle: 'bold' }, { token: 'string', foreground: '36643a' },
      { token: 'number', foreground: '8a4b10' }, { token: 'type', foreground: '5a3d8a' }, { token: 'delimiter', foreground: '1e2024' },
    ],
  },
  barbie: { base: 'vs', colors: { 'editor.background': '#fff0f8', 'editor.foreground': '#7a1a52', 'editorLineNumber.foreground': '#e6a6cc', 'editorLineNumber.activeForeground': '#e0218a', 'editor.selectionBackground': '#ffc2e0', 'editor.lineHighlightBackground': '#fde3f1', 'editorCursor.foreground': '#e0218a', 'editorWidget.background': '#fde3f1' },
    rules: [
      { token: 'comment', foreground: 'c77dae', fontStyle: 'italic' }, { token: 'keyword', foreground: 'e0218a', fontStyle: 'bold' }, { token: 'string', foreground: 'd4536f' },
      { token: 'number', foreground: '9b5de5' }, { token: 'type', foreground: 'ff5fa2' }, { token: 'delimiter', foreground: '7a1a52' },
    ],
  },
  dracula: { base: 'vs-dark', colors: { 'editor.background': '#282a36', 'editor.foreground': '#f8f8f2', 'editorLineNumber.foreground': '#6272a4', 'editorLineNumber.activeForeground': '#f8f8f2', 'editor.selectionBackground': '#44475a', 'editor.lineHighlightBackground': '#343746', 'editorCursor.foreground': '#f8f8f0', 'editorWidget.background': '#21222c' },
    rules: [
      { token: 'comment', foreground: '6272a4', fontStyle: 'italic' }, { token: 'keyword', foreground: 'ff79c6' }, { token: 'string', foreground: 'f1fa8c' },
      { token: 'number', foreground: 'bd93f9' }, { token: 'type', foreground: '8be9fd' }, { token: 'delimiter', foreground: 'f8f8f2' },
    ],
  },
  'solar-light': { base: 'vs', colors: { 'editor.background': '#fdf6e3', 'editor.foreground': '#657b83', 'editorLineNumber.foreground': '#93a1a1', 'editorLineNumber.activeForeground': '#586e75', 'editor.selectionBackground': '#eee8d5', 'editor.lineHighlightBackground': '#eee8d5', 'editorCursor.foreground': '#657b83', 'editorWidget.background': '#eee8d5' },
    rules: [
      { token: 'comment', foreground: '93a1a1', fontStyle: 'italic' }, { token: 'keyword', foreground: '859900' }, { token: 'string', foreground: '2aa198' },
      { token: 'number', foreground: 'd33682' }, { token: 'type', foreground: 'b58900' }, { token: 'delimiter', foreground: '586e75' },
    ],
  },
  'solar-dark': { base: 'vs-dark', colors: { 'editor.background': '#002b36', 'editor.foreground': '#839496', 'editorLineNumber.foreground': '#586e75', 'editorLineNumber.activeForeground': '#93a1a1', 'editor.selectionBackground': '#073642', 'editor.lineHighlightBackground': '#073642', 'editorCursor.foreground': '#839496', 'editorWidget.background': '#073642' },
    rules: [
      { token: 'comment', foreground: '586e75', fontStyle: 'italic' }, { token: 'keyword', foreground: '859900' }, { token: 'string', foreground: '2aa198' },
      { token: 'number', foreground: 'd33682' }, { token: 'type', foreground: 'b58900' }, { token: 'delimiter', foreground: '93a1a1' },
    ],
  },
  panda: { base: 'vs-dark', colors: { 'editor.background': '#292a2b', 'editor.foreground': '#e6e6e6', 'editorLineNumber.foreground': '#676b79', 'editorLineNumber.activeForeground': '#ff4b82', 'editor.selectionBackground': '#3d3f40', 'editor.lineHighlightBackground': '#31353a', 'editorCursor.foreground': '#ff4b82', 'editorWidget.background': '#31353a' },
    rules: [
      { token: 'comment', foreground: '676b79', fontStyle: 'italic' }, { token: 'keyword', foreground: 'ff75b5' }, { token: 'string', foreground: '19f9d8' },
      { token: 'number', foreground: 'ffb86c' }, { token: 'type', foreground: 'ffcc95' }, { token: 'delimiter', foreground: 'e6e6e6' },
    ],
  },
  positron: { base: 'vs-dark', colors: { 'editor.background': '#1e2030', 'editor.foreground': '#c8d3f5', 'editorLineNumber.foreground': '#4b5263', 'editorLineNumber.activeForeground': '#c8d3f5', 'editor.selectionBackground': '#2d3f76', 'editor.lineHighlightBackground': '#262b40', 'editorCursor.foreground': '#c8d3f5', 'editorWidget.background': '#262b40' },
    rules: [
      { token: 'comment', foreground: '6a7aa8', fontStyle: 'italic' }, { token: 'keyword', foreground: 'c099ff' }, { token: 'string', foreground: 'c3e88d' },
      { token: 'number', foreground: 'ff966c' }, { token: 'type', foreground: '82aaff' }, { token: 'delimiter', foreground: '89ddff' },
    ],
  },
  selenized: { base: 'vs-dark', colors: { 'editor.background': '#103c48', 'editor.foreground': '#adbcbc', 'editorLineNumber.foreground': '#3a4d53', 'editorLineNumber.activeForeground': '#adbcbc', 'editor.selectionBackground': '#184956', 'editor.lineHighlightBackground': '#0e3440', 'editorCursor.foreground': '#cacecd', 'editorWidget.background': '#0e3440' },
    rules: [
      { token: 'comment', foreground: '72898f', fontStyle: 'italic' }, { token: 'keyword', foreground: 'f275be' }, { token: 'string', foreground: '75b938' },
      { token: 'number', foreground: 'ed8649' }, { token: 'type', foreground: '41c7b9' }, { token: 'delimiter', foreground: 'adbcbc' },
    ],
  },
  skeletor: { base: 'vs-dark', colors: { 'editor.background': '#1b1030', 'editor.foreground': '#e0d4f5', 'editorLineNumber.foreground': '#4d3d6b', 'editorLineNumber.activeForeground': '#c3a6ff', 'editor.selectionBackground': '#3a2a5c', 'editor.lineHighlightBackground': '#261640', 'editorCursor.foreground': '#ffd166', 'editorWidget.background': '#261640' },
    rules: [
      { token: 'comment', foreground: '7a6a9a', fontStyle: 'italic' }, { token: 'keyword', foreground: 'ff6ec7' }, { token: 'string', foreground: '7fffb2' },
      { token: 'number', foreground: 'ffd166' }, { token: 'type', foreground: '7ec8ff' }, { token: 'delimiter', foreground: 'e0d4f5' },
    ],
  },
  tokyo: { base: 'vs-dark', colors: { 'editor.background': '#1a1b26', 'editor.foreground': '#c0caf5', 'editorLineNumber.foreground': '#3b4261', 'editorLineNumber.activeForeground': '#737aa2', 'editor.selectionBackground': '#283457', 'editor.lineHighlightBackground': '#1f2335', 'editorCursor.foreground': '#c0caf5', 'editorWidget.background': '#16161e' },
    rules: [
      { token: 'comment', foreground: '565f89', fontStyle: 'italic' }, { token: 'keyword', foreground: 'bb9af7' }, { token: 'string', foreground: '9ece6a' },
      { token: 'number', foreground: 'ff9e64' }, { token: 'type', foreground: '2ac3de' }, { token: 'delimiter', foreground: '89ddff' },
    ],
  },
  dreamweaver: { base: 'vs', colors: { 'editor.background': '#ffffff', 'editor.foreground': '#000000', 'editorLineNumber.foreground': '#808080', 'editorLineNumber.activeForeground': '#000000', 'editor.selectionBackground': '#b5d5ff', 'editor.lineHighlightBackground': '#f0f0f8', 'editorCursor.foreground': '#000000', 'editorWidget.background': '#f0f0f0' },
    rules: [
      { token: 'comment', foreground: '008000', fontStyle: 'italic' }, { token: 'keyword', foreground: '0000ff', fontStyle: 'bold' }, { token: 'string', foreground: 'c00000' },
      { token: 'number', foreground: '098658' }, { token: 'type', foreground: '800080' }, { token: 'delimiter', foreground: '000000' },
    ],
  },
  eclipse: { base: 'vs', colors: { 'editor.background': '#ffffff', 'editor.foreground': '#000000', 'editorLineNumber.foreground': '#8a8a8a', 'editorLineNumber.activeForeground': '#000000', 'editor.selectionBackground': '#c0d8f0', 'editor.lineHighlightBackground': '#e8f2fe', 'editorCursor.foreground': '#000000', 'editorWidget.background': '#f5f5f5' },
    rules: [
      { token: 'comment', foreground: '3f7f5f', fontStyle: 'italic' }, { token: 'keyword', foreground: '7f0055', fontStyle: 'bold' }, { token: 'string', foreground: '2a00ff' },
      { token: 'number', foreground: '1c00cf' }, { token: 'type', foreground: '3b0a8a' }, { token: 'delimiter', foreground: '000000' },
    ],
  },
};

// Registers the custom themes with a Monaco instance. Safe to call more than once.
export function defineEditorThemes(monaco) {
  for (const [id, t] of Object.entries(CUSTOM)) monaco.editor.defineTheme(id, { base: t.base, inherit: true, rules: t.rules, colors: t.colors });
}

// ---- User-made themes. They are stored per user (server preferences: customEditorThemes) and defined in Monaco under their id.
// Every custom theme has the same fields, so the editor and the server validate the same shape.
export const COLOR_FIELDS = [
  { key: 'editor.background', label: 'Background' }, { key: 'editor.foreground', label: 'Text' },
  { key: 'editorLineNumber.foreground', label: 'Line numbers' }, { key: 'editorLineNumber.activeForeground', label: 'Active line number' },
  { key: 'editor.selectionBackground', label: 'Selection' }, { key: 'editor.lineHighlightBackground', label: 'Current line' },
  { key: 'editorCursor.foreground', label: 'Cursor' }, { key: 'editorWidget.background', label: 'Popups and menus' },
];
export const TOKEN_FIELDS = [
  { key: 'comment', label: 'Comments' }, { key: 'keyword', label: 'Keywords' }, { key: 'string', label: 'Strings' },
  { key: 'number', label: 'Numbers' }, { key: 'type', label: 'Types' }, { key: 'delimiter', label: 'Punctuation' },
];
export const MAX_CUSTOM_THEMES = 20;
export const isCustomId = (id) => typeof id === 'string' && /^custom-[a-z0-9]{4,32}$/.test(id);
export const newCustomId = () => `custom-${Math.random().toString(36).slice(2, 10)}`;

// Colors of a built-in or custom theme, as a starting point for a new custom theme.
const BUILT_IN_PALETTES = {
  vs: { dark: false, colors: { 'editor.background': '#ffffff', 'editor.foreground': '#000000', 'editorLineNumber.foreground': '#237893', 'editorLineNumber.activeForeground': '#0b216f', 'editor.selectionBackground': '#add6ff', 'editor.lineHighlightBackground': '#f5f5f5', 'editorCursor.foreground': '#000000', 'editorWidget.background': '#f3f3f3' },
    tokens: { comment: '#008000', keyword: '#0000ff', string: '#a31515', number: '#098658', type: '#267f99', delimiter: '#000000' } },
  'vs-dark': { dark: true, colors: { 'editor.background': '#1e1e1e', 'editor.foreground': '#d4d4d4', 'editorLineNumber.foreground': '#858585', 'editorLineNumber.activeForeground': '#c6c6c6', 'editor.selectionBackground': '#264f78', 'editor.lineHighlightBackground': '#282828', 'editorCursor.foreground': '#aeafad', 'editorWidget.background': '#252526' },
    tokens: { comment: '#6a9955', keyword: '#569cd6', string: '#ce9178', number: '#b5cea8', type: '#4ec9b0', delimiter: '#d4d4d4' } },
  'hc-black': { dark: true, colors: { 'editor.background': '#000000', 'editor.foreground': '#ffffff', 'editorLineNumber.foreground': '#ffffff', 'editorLineNumber.activeForeground': '#ffffff', 'editor.selectionBackground': '#264f78', 'editor.lineHighlightBackground': '#1a1a1a', 'editorCursor.foreground': '#ffffff', 'editorWidget.background': '#000000' },
    tokens: { comment: '#7ca668', keyword: '#569cd6', string: '#ce9178', number: '#b5cea8', type: '#4ec9b0', delimiter: '#ffffff' } },
};
export function paletteOf(themeId) {
  if (BUILT_IN_PALETTES[themeId]) return structuredClone(BUILT_IN_PALETTES[themeId]);
  const c = CUSTOM[themeId];
  if (!c) return structuredClone(BUILT_IN_PALETTES['vs-dark']);
  const tokens = Object.fromEntries(c.rules.map((r) => [r.token, `#${r.foreground}`]));
  return { dark: !!EDITOR_THEMES.find((t) => t.id === themeId)?.dark, colors: { ...c.colors }, tokens: { comment: tokens.comment, keyword: tokens.keyword, string: tokens.string, number: tokens.number, type: tokens.type, delimiter: tokens.delimiter } };
}

// Monaco's definition of a custom theme. Comments are italic, as in the built-in palettes.
export function customMonacoTheme(t) {
  return {
    base: t.dark ? 'vs-dark' : 'vs', inherit: true,
    rules: TOKEN_FIELDS.map(({ key }) => ({ token: key, foreground: t.tokens[key].slice(1), ...(key === 'comment' ? { fontStyle: 'italic' } : {}) })),
    colors: { ...t.colors },
  };
}
export function defineCustomThemes(monaco, list) {
  for (const t of list || []) monaco.editor.defineTheme(t.id, customMonacoTheme(t));
}

// Whether a theme id (built-in or custom) is dark. A custom id is looked up in the user's list.
export function themeIsDark(id, customs = []) {
  const c = customs.find((t) => t.id === id);
  return c ? !!c.dark : isDarkEditorTheme(id);
}
