import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, FormControlLabel, IconButton, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import EditIcon from '@mui/icons-material/EditOutlined';
import DeleteIcon from '@mui/icons-material/DeleteOutlined';
import CheckIcon from '@mui/icons-material/Check';
import { get, post, put, del } from '../api.js';

// What the agent has learned: general preferences about you, and (given a projectId) notes about one project.
// Off by default; each scope has its own switch. You can read, edit, add, and delete every note, or clear them all.
export default function MemoryManager({ projectId }) {
  const [data, setData] = useState(null); const [msg, setMsg] = useState(null);
  const load = useCallback(() => get(`/api/memory${projectId ? `?projectId=${projectId}` : ''}`).then(setData).catch((e) => setMsg({ s: 'error', t: e.body?.error || 'Failed to load memory' })), [projectId]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn) => { try { await fn(); setMsg(null); await load(); } catch (e) { setMsg({ s: 'error', t: e.body?.message || e.body?.error || 'Failed' }); } };
  if (!data) return msg ? <Alert severity="error">{msg.t}</Alert> : null;
  if (!data.allowed) return <Alert severity="info">Memory has been turned off by your administrator.</Alert>;
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>When memory is on, the agent can save short notes about your preferences or a project and uses them in later sessions. It is off until you turn it on. You always see what is saved here, and can change or delete it.</Typography>
      {msg && <Alert severity={msg.s} sx={{ mb: 1 }} onClose={() => setMsg(null)}>{msg.t}</Alert>}
      <Scope title="About you (all projects)" scope="user" data={data.user} maxText={data.maxText} act={act} />
      {data.project && <Scope title={`About the project “${data.project.name}”`} scope="project" projectId={data.project.id} data={data.project} maxText={data.maxText} act={act} />}
    </Box>
  );
}

function Scope({ title, scope, projectId, data, maxText, act }) {
  const [draft, setDraft] = useState(''); const [editing, setEditing] = useState(null);
  const where = { scope, ...(projectId ? { projectId } : {}) };
  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2 }} data-testid={`memory-${scope}`}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="subtitle1" sx={{ flexGrow: 1 }}>{title}</Typography>
        <FormControlLabel sx={{ mr: 0 }} label={data.enabled ? 'On' : 'Off'} control={<Switch checked={data.enabled} onChange={(e) => act(() => put('/api/memory/settings', { ...where, enabled: e.target.checked }))} slotProps={{ input: { 'aria-label': `Memory ${scope}` } }} />} />
      </Stack>
      {!data.entries.length && <Typography variant="body2" color="text.secondary" sx={{ my: 1 }}>Nothing saved yet.</Typography>}
      <Stack spacing={0.5} sx={{ my: 1 }}>
        {data.entries.map((e) => (
          <Stack key={e.id} direction="row" alignItems="center" spacing={1} data-testid="memory-entry">
            {editing?.id === e.id ? (
              <>
                <TextField size="small" fullWidth autoFocus value={editing.text} onChange={(x) => setEditing({ ...editing, text: x.target.value })} slotProps={{ htmlInput: { maxLength: maxText, 'aria-label': 'Edit memory' } }} />
                <IconButton aria-label="Save memory" onClick={() => act(async () => { await put(`/api/memory/entries/${e.id}`, { text: editing.text }); setEditing(null); })}><CheckIcon /></IconButton>
              </>
            ) : (
              <>
                <Typography variant="body2" sx={{ flexGrow: 1, wordBreak: 'break-word' }}>{e.text}</Typography>
                {e.source === 'agent' && <Chip size="small" variant="outlined" label="agent" />}
                <IconButton size="small" aria-label={`Edit ${e.text}`} onClick={() => setEditing({ id: e.id, text: e.text })}><EditIcon fontSize="small" /></IconButton>
                <IconButton size="small" aria-label={`Delete ${e.text}`} onClick={() => act(() => del(`/api/memory/entries/${e.id}`))}><DeleteIcon fontSize="small" /></IconButton>
              </>
            )}
          </Stack>))}
      </Stack>
      <Stack direction="row" spacing={1}>
        <TextField size="small" fullWidth placeholder="Add a note…" value={draft} onChange={(e) => setDraft(e.target.value)} slotProps={{ htmlInput: { maxLength: maxText, 'aria-label': `New ${scope} memory` } }} onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { e.preventDefault(); act(async () => { await post('/api/memory/entries', { ...where, text: draft }); setDraft(''); }); } }} />
        <Button disabled={!draft.trim()} onClick={() => act(async () => { await post('/api/memory/entries', { ...where, text: draft }); setDraft(''); })}>Add</Button>
        <Button color="warning" disabled={!data.entries.length} onClick={() => window.confirm('Delete everything in this memory?') && act(() => del(`/api/memory?scope=${scope}${projectId ? `&projectId=${projectId}` : ''}`))}>Clear all</Button>
      </Stack>
    </Paper>
  );
}
