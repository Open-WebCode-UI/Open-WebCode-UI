import { useEffect, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { COLOR_FIELDS, TOKEN_FIELDS, MAX_CUSTOM_THEMES, EDITOR_THEMES, paletteOf, newCustomId } from './editorThemes.js';
import ThemePreview from './ThemePreview.jsx';

// The user's own editor themes: a name, a light or dark base, and a color for each part of the editor and each kind of syntax.
// A live sample on the right shows the colors as they are picked. Saving stores the theme for this user (on the server), so it
// is available on every device.
const HEX = /^#[0-9a-fA-F]{6}$/;
const clone = (t) => ({ ...t, colors: { ...t.colors }, tokens: { ...t.tokens } });

function fromPalette(themeId) {
  const p = paletteOf(themeId);
  return { id: newCustomId(), name: 'My theme', dark: p.dark, colors: p.colors, tokens: p.tokens };
}

function ColorField({ label, value, onChange }) {
  const ok = HEX.test(value);
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Typography sx={{ flex: 1, fontSize: 13 }}>{label}</Typography>
      <input type="color" aria-label={label} value={ok ? value : '#000000'} onChange={(e) => onChange(e.target.value)}
        style={{ width: 36, height: 28, padding: 0, border: 0, background: 'none', cursor: 'pointer' }} />
      <TextField size="small" value={value} onChange={(e) => onChange(e.target.value)} error={!ok} sx={{ width: 118 }}
        slotProps={{ htmlInput: { 'aria-label': `${label} hex color`, maxLength: 7, style: { fontFamily: 'monospace' } } }} />
    </Stack>
  );
}

// `themes` is the user's list. `editId` names the theme to edit, or is null for a new one. `startFrom` is the theme a new one copies.
// onSave(list, { apply, removed }) stores the new list; `apply` is the id to switch the editor to (or null), `removed` a deleted id.
export default function ThemeEditor({ open, themes, editId, startFrom, onSave, onClose }) {
  const editing = themes.find((t) => t.id === editId) || null;
  const [draft, setDraft] = useState(null);
  const [start, setStart] = useState(startFrom);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // A fresh draft each time the dialog opens: a copy of the theme being edited, or a new one based on the chosen palette.
  useEffect(() => {
    if (!open) return;
    setErr(''); setConfirmDelete(false); setBusy(false); setStart(startFrom);
    setDraft(editing ? clone(editing) : fromPalette(startFrom));
  }, [open, editId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!draft) return <Dialog open={false} onClose={onClose} />;
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setColor = (group, key, value) => setDraft((d) => ({ ...d, [group]: { ...d[group], [key]: value } }));
  const fieldsValid = [...Object.values(draft.colors), ...Object.values(draft.tokens)].every((v) => HEX.test(v));
  const nameOk = draft.name.trim().length > 0 && draft.name.trim().length <= 40;
  const full = !editing && themes.length >= MAX_CUSTOM_THEMES;

  const save = async () => {
    setErr('');
    const next = { id: draft.id, name: draft.name.trim(), dark: draft.dark, colors: draft.colors, tokens: draft.tokens };
    const list = editing ? themes.map((t) => (t.id === editing.id ? next : t)) : [...themes, next];
    setBusy(true);
    try { await onSave(list, { apply: next.id, removed: null }); } catch { setErr('Could not save this theme. Try again.'); setBusy(false); }
  };
  const remove = async () => {
    setErr(''); setBusy(true);
    try { await onSave(themes.filter((t) => t.id !== editing.id), { apply: null, removed: editing.id }); } catch { setErr('Could not delete this theme. Try again.'); setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth aria-labelledby="theme-editor-title">
      <DialogTitle id="theme-editor-title">{editing ? `Edit theme: ${editing.name}` : 'New theme'}</DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 1fr)' }, gap: 3 }}>
          <Stack spacing={2}>
            <TextField label="Name" size="small" value={draft.name} onChange={(e) => set({ name: e.target.value })} slotProps={{ htmlInput: { maxLength: 40 } }} />
            {!editing && (
              <TextField select label="Start from" size="small" value={start} helperText="Copies that theme's colors. You can change any of them below."
                onChange={(e) => { setStart(e.target.value); const p = paletteOf(e.target.value); set({ dark: p.dark, colors: p.colors, tokens: p.tokens }); }}>
                {EDITOR_THEMES.map((t) => <MenuItem key={t.id} value={t.id}>{t.label}</MenuItem>)}
              </TextField>
            )}
            <TextField select label="Base" size="small" value={draft.dark ? 'dark' : 'light'} onChange={(e) => set({ dark: e.target.value === 'dark' })}
              helperText="Sets whether the editor counts as dark (for Rainbow CSV colors).">
              <MenuItem value="light">Light</MenuItem>
              <MenuItem value="dark">Dark</MenuItem>
            </TextField>
            <Typography variant="subtitle2">Editor</Typography>
            {COLOR_FIELDS.map((f) => <ColorField key={f.key} label={f.label} value={draft.colors[f.key]} onChange={(v) => setColor('colors', f.key, v)} />)}
            <Typography variant="subtitle2">Syntax</Typography>
            {TOKEN_FIELDS.map((f) => <ColorField key={f.key} label={f.label} value={draft.tokens[f.key]} onChange={(v) => setColor('tokens', f.key, v)} />)}
          </Stack>
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>Preview</Typography>
            <ThemePreview draft={draft} />
          </Box>
        </Box>
        {full && <Alert severity="info" sx={{ mt: 2 }}>You can keep up to {MAX_CUSTOM_THEMES} themes. Delete one to make another.</Alert>}
        {err && <Alert severity="error" sx={{ mt: 2 }}>{err}</Alert>}
      </DialogContent>
      <DialogActions>
        {editing && (confirmDelete
          ? <Button color="error" onClick={remove} disabled={busy}>Confirm delete</Button>
          : <Button color="error" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete</Button>)}
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={busy || !nameOk || !fieldsValid || full}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
