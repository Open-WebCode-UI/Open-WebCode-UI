import { useCallback, useEffect, useState } from 'react';
import { Box, List, ListItem, ListItemText, Button, Stack, Typography, Dialog, DialogTitle, DialogContent, DialogActions, Chip, TextField, Alert } from '@mui/material';
import { DiffEditor } from '@monaco-editor/react';
import { get, post } from '../api.js';
import { useAuth } from '../AuthContext.jsx';

export default function CheckpointsPanel({ project, refreshKey, focus, onRestored, monacoTheme }) {
  const { can } = useAuth();
  const [items, setItems] = useState([]); const [label, setLabel] = useState('');
  const [confirm, setConfirm] = useState(null); const [diff, setDiff] = useState(null); const [err, setErr] = useState('');
  const base = `/api/projects/${project?.id}/checkpoints`;
  const load = useCallback(() => { if (project) get(base).then(setItems).catch(() => setItems([])); }, [project, base]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const [flash, setFlash] = useState(null);
  // Scroll to and briefly highlight the checkpoint that was clicked in the conversation.
  useEffect(() => {
    if (!focus?.id || !items.some((c) => c.id === focus.id)) return undefined;
    setFlash(focus.id);
    document.getElementById(`cp-${focus.id}`)?.scrollIntoView?.({ block: 'center' });
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [focus, items]);

  const create = async () => { try { await post(base, { label: label || 'Manual checkpoint' }); setLabel(''); load(); } catch (e) { setErr(e.body?.error || 'Failed'); } };
  const restore = async (cp) => {
    setConfirm(null); setErr('');
    try { await post(`${base}/${cp.id}/restore`); load(); onRestored?.(); } catch (e) { if (e.message !== 'canceled') setErr(e.body?.error || 'Restore failed'); }
  };
  const showDiff = async (cp) => {
    const r = await get(`${base}/${cp.id}/diff`);
    if (!r.files.length) { setDiff({ cp, files: [], none: true }); return; }
    setDiff({ cp, files: r.files, file: r.files[0].path, ...(await fileDiff(cp, r.files[0].path)) });
  };
  const fileDiff = async (cp, file) => {
    const [old, cur] = await Promise.all([get(`${base}/${cp.id}/diff?file=${encodeURIComponent(file)}`), get(`/api/projects/${project.id}/file?path=${encodeURIComponent(file)}`).catch(() => ({ content: '' }))]);
    return { original: old.checkpointContent, modified: cur.content };
  };
  if (!project) return <Box sx={{ p: 2 }}><Typography color="text.secondary">No project selected.</Typography></Box>;
  return (
    <Box sx={{ p: 1, overflow: 'auto', height: '100%' }}>
      {err && <Alert severity="error" onClose={() => setErr('')} sx={{ mb: 1 }}>{err}</Alert>}
      {can('checkpoint.write') && (
        <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
          <TextField size="small" fullWidth label="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button variant="outlined" onClick={create}>Save</Button>
        </Stack>
      )}
      <List dense>
        {items.map((cp) => (
          <ListItem key={cp.id} id={`cp-${cp.id}`} divider data-focused={flash === cp.id || undefined} sx={{ transition: 'background-color .4s', bgcolor: flash === cp.id ? 'action.selected' : 'transparent' }} secondaryAction={<>
            <Button size="small" onClick={() => showDiff(cp)}>Diff</Button>
            {can('checkpoint.write') && <Button size="small" color="warning" onClick={() => setConfirm(cp)}>Rollback</Button>}
          </>}>
            <ListItemText primary={<>{cp.label} <Chip size="small" label={cp.author} sx={{ ml: 0.5 }} /></>} secondary={new Date(cp.ts * 1000).toLocaleString()} />
          </ListItem>
        ))}
        {!items.length && <Typography color="text.secondary" variant="body2" sx={{ p: 1 }}>No checkpoints yet.</Typography>}
      </List>
      <Dialog open={!!confirm} onClose={() => setConfirm(null)}>
        <DialogTitle>Roll back to “{confirm?.label}”?</DialogTitle>
        <DialogContent><Typography variant="body2">Your project files will be reset to this checkpoint. Agent sessions go back too: messages after this point are grayed out and hidden from the agent. A “Before restore” checkpoint is saved first, so you can undo this.</Typography></DialogContent>
        <DialogActions><Button onClick={() => setConfirm(null)}>Cancel</Button><Button color="warning" variant="contained" onClick={() => restore(confirm)}>Roll back</Button></DialogActions>
      </Dialog>
      <Dialog open={!!diff} onClose={() => setDiff(null)} fullWidth maxWidth="lg">
        <DialogTitle>Changes since “{diff?.cp.label}”</DialogTitle>
        <DialogContent>
          {diff?.none ? <Typography>No differences.</Typography> : diff && (
            <Stack direction="row" spacing={1}>
              <List dense sx={{ minWidth: 180 }}>{diff.files.map((f) => <ListItem key={f.path} disablePadding><Button size="small" onClick={async () => setDiff({ ...diff, file: f.path, ...(await fileDiff(diff.cp, f.path)) })}>{f.status} {f.path}</Button></ListItem>)}</List>
              <Box sx={{ flexGrow: 1, height: 420 }}><DiffEditor original={diff.original} modified={diff.modified} theme={monacoTheme} options={{ readOnly: true, renderSideBySide: true }} /></Box>
            </Stack>
          )}
        </DialogContent>
        <DialogActions><Button onClick={() => setDiff(null)}>Close</Button></DialogActions>
      </Dialog>
    </Box>
  );
}
