import { Box, Typography } from '@mui/material';

// A sample of code in a theme's colors, with the current line, line numbers, a widget and a cursor. `draft` is any object with
// `colors` and `tokens` (a user's theme being edited, or a built-in palette).
// Sample code in the theme's colors. Line 4 is the current line, so its highlight shows too.
const SAMPLE = [
  [['comment', '// Greet the user']],
  [['keyword', 'function'], ['', ' '], ['type', 'greet'], ['delimiter', '('], ['', 'name'], ['delimiter', ') {']],
  [['', '  const '], ['keyword', 'count'], ['', ' = '], ['number', '3'], ['delimiter', ';']],
  [['', '  return '], ['string', '"Hello, "'], ['delimiter', ' + '], ['', 'name'], ['delimiter', ';']],
  [['delimiter', '}']],
];
export default function ThemePreview({ draft }) {
  const c = draft.colors, t = draft.tokens;
  const tokenColor = (k) => (k === '' ? c['editor.foreground'] : t[k]);
  return (
    <Box data-testid="theme-preview" sx={{ borderRadius: 1, border: 1, borderColor: 'divider', overflow: 'hidden', fontFamily: 'monospace', fontSize: 13 }}>
      <Box sx={{ bgcolor: c['editor.background'], py: 1 }}>
        {SAMPLE.map((line, i) => {
          const current = i === 3;
          return (
            <Box key={i} sx={{ display: 'flex', whiteSpace: 'pre', px: 1, bgcolor: current ? c['editor.lineHighlightBackground'] : 'transparent' }}>
              <Box component="span" sx={{ width: 24, flexShrink: 0, textAlign: 'right', pr: 1.5, color: current ? c['editorLineNumber.activeForeground'] : c['editorLineNumber.foreground'] }}>{i + 1}</Box>
              <Box component="span">{line.map(([k, text], j) => (
                <Box key={j} component="span" sx={{ color: tokenColor(k), fontStyle: k === 'comment' ? 'italic' : 'normal' }}>{text}</Box>
              ))}</Box>
            </Box>
          );
        })}
      </Box>
      <Box sx={{ bgcolor: c['editorWidget.background'], color: c['editor.foreground'], p: 1, borderTop: 1, borderColor: 'divider' }}>
        <Box component="span" sx={{ color: c['editor.foreground'] }}>greet(</Box><Box component="span" sx={{ bgcolor: c['editor.selectionBackground'] }}>name</Box><Box component="span">)</Box>
        <Box component="span" sx={{ ml: 1, color: c['editorCursor.foreground'] }}>|</Box>
      </Box>
    </Box>
  );
}

