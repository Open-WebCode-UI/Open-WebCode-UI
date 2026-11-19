import { EDITOR_THEME_IDS, isCustomId } from './editorThemes.js';

export const DEFAULT_PREFS = { wordWrap: false, minimap: false, whitespace: false, lineNumbers: true, fontSize: 13, theme: '', rainbowCsv: false, altClickCursors: true };
const KEY = 'ide-editor-prefs-v1';
export const MIN_FONT = 8, MAX_FONT = 32;

export function normalizePrefs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const b = (k) => (typeof r[k] === 'boolean' ? r[k] : DEFAULT_PREFS[k]);
  const fs = Number.isFinite(r.fontSize) ? Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(r.fontSize))) : DEFAULT_PREFS.fontSize;
  return { wordWrap: b('wordWrap'), minimap: b('minimap'), whitespace: b('whitespace'), lineNumbers: b('lineNumbers'), fontSize: fs, theme: EDITOR_THEME_IDS.includes(r.theme) || isCustomId(r.theme) ? r.theme : '', rainbowCsv: b('rainbowCsv'), altClickCursors: b('altClickCursors') };
}
export function loadPrefs() { try { return normalizePrefs(JSON.parse(localStorage.getItem(KEY))); } catch { return { ...DEFAULT_PREFS }; } }
export function savePrefs(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable */ } }

// Monaco options derived from the preferences.
// The glyph margin (where breakpoints sit) is shown only for a language that can be debugged.
export const monacoOptions = (p, readOnly, debuggable = false) => ({
  readOnly, minimap: { enabled: p.minimap }, fontSize: p.fontSize, wordWrap: p.wordWrap ? 'on' : 'off', renderWhitespace: p.whitespace ? 'all' : 'selection',
  lineNumbers: p.lineNumbers ? 'on' : 'off', automaticLayout: true, scrollBeyondLastLine: false, contextmenu: true, fixedOverflowWidgets: true,
  multiCursorModifier: p.altClickCursors === false ? 'ctrlCmd' : 'alt', glyphMargin: debuggable,
});
