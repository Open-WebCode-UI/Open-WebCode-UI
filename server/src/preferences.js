import { z } from 'zod';

export const DEFAULT_PREFERENCES = { colorMode: null, fontScale: 100, reduceMotion: false, highContrast: false, underlineLinks: false };

export const prefSchema = z.object({
  colorMode: z.enum(['system', 'light', 'dark']).nullable(),
  fontScale: z.union([z.literal(100), z.literal(115), z.literal(130), z.literal(150)]),
  reduceMotion: z.boolean(),
  highContrast: z.boolean(),
  underlineLinks: z.boolean(),
}).strict();

// Stored preferences are re-validated on read so a hand-edited or older row can never break the UI.
export function readPreferences(user) {
  let stored = {};
  try { stored = JSON.parse(user.preferences || '{}'); } catch { /* fall back to defaults */ }
  const ok = prefSchema.safeParse({ ...DEFAULT_PREFERENCES, ...stored });
  return ok.success ? ok.data : { ...DEFAULT_PREFERENCES };
}
