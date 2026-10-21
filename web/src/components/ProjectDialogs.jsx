import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Stack, TextField, Typography } from '@mui/material';
import { get, post } from '../api.js';

export function PromptDialog({ title, label, onOk, onClose, initial = '', okLabel = 'OK' }) {
  const [v, setV] = useState(initial);
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent><TextField autoFocus fullWidth margin="dense" label={label} value={v} onFocus={(e) => e.target.select()} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) { e.preventDefault(); onOk(v.trim()); } }} /* preventDefault: otherwise this Enter reaches the button that regains focus when the dialog closes and reopens it */ /></DialogContent>
      <DialogActions><Button onClick={onClose}>Cancel</Button><Button variant="contained" disabled={!v.trim()} onClick={() => onOk(v.trim())}>{okLabel}</Button></DialogActions>
    </Dialog>
  );
}

export function NewProjectDialog({ onClose, onCreated }) {
  const [name, setName] = useState(''); const [gitUrl, setGitUrl] = useState(''); const [token, setToken] = useState(''); const [zip, setZip] = useState(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async () => {
    setErr(''); setBusy(true);
    try {
      if (zip) {
        const b64 = btoa(new Uint8Array(await zip.arrayBuffer()).reduce((s, b) => s + String.fromCharCode(b), ''));
        onCreated((await post('/api/projects/import', { name, zipBase64: b64 })).id);
      } else if (gitUrl) onCreated((await post('/api/projects/import', { name, gitUrl, token: token || undefined })).id);
      else onCreated((await post('/api/projects', { name })).id);
    } catch (e) { setErr(e.body?.error || 'Failed'); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>New project</DialogTitle>
      <DialogContent>
        {err && <Alert severity="error" sx={{ mb: 1 }}>{err}</Alert>}
        <TextField autoFocus fullWidth margin="dense" label="Project name" value={name} onChange={(e) => setName(e.target.value)} />
        <Typography variant="subtitle2" sx={{ mt: 2 }}>Or open existing code</Typography>
        <Button component="label" size="small" sx={{ my: 1 }}>{zip ? zip.name : 'Upload .zip'}<input hidden type="file" accept=".zip" onChange={(e) => setZip(e.target.files[0] || null)} /></Button>
        <TextField fullWidth margin="dense" label="…or clone from Git (https URL)" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} />
        {gitUrl && <TextField fullWidth margin="dense" type="password" label="Access token (optional, not stored)" value={token} onChange={(e) => setToken(e.target.value)} />}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Cancel</Button><Button variant="contained" disabled={!name || busy} onClick={submit}>Create</Button></DialogActions>
    </Dialog>
  );
}

export function GitDialog({ project, can, onClose }) {
  const [status, setStatus] = useState(null); const [msg, setMsg] = useState(''); const [remote, setRemote] = useState(''); const [branch, setBranch] = useState('main'); const [token, setToken] = useState(''); const [out, setOut] = useState(''); const [err, setErr] = useState('');
  const load = () => get(`/api/projects/${project.id}/git/status`).then(setStatus).catch(() => {});
  useEffect(() => { load(); }, []); // eslint-disable-line
  const act = async (fn) => { setErr(''); setOut(''); try { setOut(await fn()); load(); } catch (e) { setErr(e.body?.message || e.body?.error || 'Failed'); } };
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Git</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
        {err && <Alert severity="error" >{err}</Alert>}{out && <Alert severity="success" >{out}</Alert>}
        <Typography variant="body2">{status?.initialized ? `Branch ${status.branch}, ${status.files.length} changed file(s)` : 'Not a Git repository yet (committing will initialize one).'}</Typography>
        <TextField fullWidth label="Commit message" value={msg} onChange={(e) => setMsg(e.target.value)} />
        <Button variant="contained" sx={{ alignSelf: 'flex-start' }} disabled={!msg} onClick={() => act(async () => { const r = await post(`/api/projects/${project.id}/git/commit`, { message: msg }); setMsg(''); return `Committed ${r.commit}`; })}>Commit all changes</Button>
        {can('git.push') && (
          <>
            <Divider />
            <TextField fullWidth label="Remote URL (https)" value={remote} onChange={(e) => setRemote(e.target.value)} />
            <Stack direction="row" spacing={2}><TextField label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)} /><TextField fullWidth type="password" label="Access token (not stored)" value={token} onChange={(e) => setToken(e.target.value)} /></Stack>
            <Button variant="outlined" sx={{ alignSelf: 'flex-start' }} disabled={!remote} onClick={() => act(async () => { await post(`/api/projects/${project.id}/git/push`, { remoteUrl: remote, branch, token: token || undefined }); setToken(''); return 'Pushed'; })}>Push</Button>
          </>
        )}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}
