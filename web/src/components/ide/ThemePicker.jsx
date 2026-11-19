import { useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, ListItemButton, ListItemText, ListSubheader, Stack, Typography } from '@mui/material';
import { EDITOR_THEMES, paletteOf } from './editorThemes.js';
import ThemePreview from './ThemePreview.jsx';

// Color theme chooser, shaped like the language picker: a list on the left and, on the right, a preview of the theme under the
// pointer or keyboard focus (or the current one). Clicking a theme applies it and closes the dialog.
// `current` is the chosen theme id ('' for the app default); `active` is the theme the editor is showing now.
export default function ThemePicker({ open, current, active, defaultTheme, customThemes, onPick, onNewTheme, onEditTheme, onClose }) {
  const [hover, setHover] = useState(null);
  const shownId = hover ?? (current || defaultTheme);
  const custom = customThemes.find((t) => t.id === shownId);
  const label = custom ? custom.name : (EDITOR_THEMES.find((t) => t.id === shownId)?.label ?? 'App default');
  const palette = custom ?? paletteOf(shownId);
  const row = (id, text, isCurrent) => (
    <ListItemButton key={id || 'default'} selected={isCurrent} aria-current={isCurrent ? 'true' : undefined}
      onMouseEnter={() => setHover(id)} onFocus={() => setHover(id)} onMouseLeave={() => setHover(null)} onBlur={() => setHover(null)}
      onClick={() => onPick(id)} sx={{ borderRadius: 1 }}>
      <ListItemText primary={text} />
    </ListItemButton>
  );

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth aria-labelledby="color-theme-title" onExited={() => setHover(null)}>
      <DialogTitle id="color-theme-title">Color theme</DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '220px minmax(0, 1fr)' }, gap: 2 }}>
          <Box aria-label="Color themes" sx={{ maxHeight: 420, overflow: 'auto', pr: 0.5 }}>
            <ListSubheader disableSticky sx={{ lineHeight: '28px' }}>Built in</ListSubheader>
            {row('', 'App default', !current)}
            {EDITOR_THEMES.map((t) => row(t.id, t.label, current === t.id))}
            {customThemes.length > 0 && <>
              <ListSubheader disableSticky sx={{ lineHeight: '28px' }}>My themes</ListSubheader>
              {customThemes.map((t) => row(t.id, t.name, current === t.id))}
            </>}
          </Box>
          <Stack spacing={1} sx={{ minWidth: 0 }}>
            <Typography variant="subtitle2">{label}</Typography>
            <Typography variant="caption" color="text.secondary">{palette.dark ? 'Dark' : 'Light'}{shownId === active ? ' · in use' : ''}</Typography>
            <ThemePreview draft={palette} />
          </Stack>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onNewTheme}>New theme…</Button>
        <Button disabled={!custom} onClick={() => onEditTheme(custom.id)}>Edit this theme…</Button>
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}
