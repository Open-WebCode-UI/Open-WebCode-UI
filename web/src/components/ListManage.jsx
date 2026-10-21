import { useEffect, useState } from 'react';
import { Box, Button, Checkbox, Stack, Typography } from '@mui/material';

// Select mode for a list of saved sessions or chats: tick items, then delete the ticked ones or all of them.
// `ids` is the current list, so ticks for items that have gone away are dropped.
export function useSelection(ids) {
  const [selecting, setSelecting] = useState(false); const [sel, setSel] = useState(() => new Set());
  const key = ids.join(',');
  useEffect(() => { setSel((s) => { const keep = new Set(ids.filter((i) => s.has(i))); return keep.size === s.size ? s : keep; }); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    selecting, sel,
    start: () => setSelecting(true),
    stop: () => { setSelecting(false); setSel(new Set()); },
    toggle: (id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
    selectAll: () => setSel(new Set(ids)),
    clear: () => setSel(new Set()),
  };
}

export const RowCheckbox = ({ selection, id, label }) => (
  <Checkbox edge="start" size="small" checked={selection.sel.has(id)} tabIndex={-1} disableRipple sx={{ py: 0, mr: 0.5 }} slotProps={{ input: { 'aria-label': `Select ${label}` } }} onClick={(e) => e.stopPropagation()} onChange={() => selection.toggle(id)} />
);

// Buttons above the list. `noun` is "session" or "chat". onDelete(ids) and onDeleteAll() do the work (and may throw).
export function SelectionBar({ selection, ids, noun, onDelete, onDeleteAll }) {
  const [err, setErr] = useState('');
  const n = selection.sel.size;
  const run = async (confirmText, fn) => { setErr(''); if (!window.confirm(confirmText)) return; try { await fn(); selection.stop(); } catch { setErr(`Could not delete the ${noun}s.`); } };
  if (!selection.selecting) return ids.length ? <Box sx={{ px: 1, pb: 0.5 }}><Button size="small" onClick={selection.start}>Select</Button></Box> : null;
  const plural = (k) => `${k} ${noun}${k === 1 ? '' : 's'}`;
  return (
    <Box sx={{ px: 1, pb: 0.5 }} role="group" aria-label={`Manage ${noun}s`}>
      <Stack direction="row" alignItems="center" spacing={0.5} flexWrap="wrap" useFlexGap>
        <Checkbox size="small" sx={{ p: 0.5 }} checked={n > 0 && n === ids.length} indeterminate={n > 0 && n < ids.length} onChange={() => (n === ids.length ? selection.clear() : selection.selectAll())} slotProps={{ input: { 'aria-label': `Select all ${noun}s` } }} />
        <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>{n} selected</Typography>
        <Button size="small" onClick={selection.stop}>Done</Button>
      </Stack>
      <Stack direction="row" spacing={0.5}>
        <Button size="small" color="error" variant="outlined" disabled={!n} onClick={() => run(`Delete ${plural(n)}? This cannot be undone.`, () => onDelete([...selection.sel]))}>Delete{n ? ` (${n})` : ''}</Button>
        <Button size="small" color="error" onClick={() => run(`Delete all ${plural(ids.length)}? This cannot be undone.`, onDeleteAll)}>Delete all</Button>
      </Stack>
      {err && <Typography variant="caption" color="error" role="alert">{err}</Typography>}
    </Box>
  );
}
