import { z } from 'zod';

// autoCompact: summarize a chat session on its own when its context is over 80% full (the same setting as /auto-compact).
export const DEFAULT_PREFERENCES = { colorMode: null, fontScale: 100, reduceMotion: false, highContrast: false, underlineLinks: false, autoCompact: false, customEditorThemes: [] };

// A user's own code editor theme (see web/src/components/ide/editorThemes.js). Every field is required, so the editor always sends the whole theme.
const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const EDITOR_COLOR_KEYS = ['editor.background', 'editor.foreground', 'editorLineNumber.foreground', 'editorLineNumber.activeForeground', 'editor.selectionBackground', 'editor.lineHighlightBackground', 'editorCursor.foreground', 'editorWidget.background'];
const TOKEN_KEYS = ['comment', 'keyword', 'string', 'number', 'type', 'delimiter'];
export const customThemeSchema = z.object({
  id: z.string().regex(/^custom-[a-z0-9]{4,32}$/),
  name: z.string().trim().min(1).max(40),
  dark: z.boolean(),
  colors: z.object(Object.fromEntries(EDITOR_COLOR_KEYS.map((k) => [k, HEX]))).strict(),
  tokens: z.object(Object.fromEntries(TOKEN_KEYS.map((k) => [k, HEX]))).strict(),
}).strict();

export const prefSchema = z.object({
  colorMode: z.enum(['system', 'light', 'dark']).nullable(),
  fontScale: z.union([z.literal(100), z.literal(115), z.literal(130), z.literal(150)]),
  reduceMotion: z.boolean(),
  highContrast: z.boolean(),
  underlineLinks: z.boolean(),
  autoCompact: z.boolean(),
  customEditorThemes: z.array(customThemeSchema).max(20).refine((list) => new Set(list.map((t) => t.id)).size === list.length, 'Theme ids must be unique'),
}).strict();

// Stored preferences are re-validated on read so a hand-edited or older row can never break the UI.
export function readPreferences(user) {
  let stored = {};
  try { stored = JSON.parse(user.preferences || '{}'); } catch { /* fall back to defaults */ }
  const ok = prefSchema.safeParse({ ...DEFAULT_PREFERENCES, ...stored });
  return ok.success ? ok.data : { ...DEFAULT_PREFERENCES };
}
