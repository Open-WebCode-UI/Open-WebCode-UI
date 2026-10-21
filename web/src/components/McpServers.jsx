import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import { get, post, put, del } from '../api.js';
import { useAuth } from '../AuthContext.jsx';

// "Header-Name: value" per line -> object. Blank input means "leave as is" (undefined), so stored credentials are never echoed back.
export function parseHeaders(text) {
  const t = text.trim(); if (!t) return undefined;
  const out = {};
  for (const line of t.split('\n')) {
    const i = line.indexOf(':'); if (i < 1) throw new Error(`Header lines look like "Name: value" (got "${line.slice(0, 30)}")`);
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };

export function McpServerDialog({ init, admin, onClose, onSave }) {
  const [f, setF] = useState({ name: '', url: '', headers: '', enabled: true, allowPrivate: false, ...init, headers: '' });
  const [err, setErr] = useState('');
  const isNew = !init?.id;
  const submit = async () => {
    setErr('');
    try {
      const body = { name: f.name.trim(), url: f.url.trim(), enabled: f.enabled, ...(admin ? { allowPrivate: f.allowPrivate } : {}) };
      const h = parseHeaders(f.headers); if (h !== undefined) body.headers = h;
      await onSave(body, init);
    } catch (e) { setErr(e.message === 'canceled' ? '' : e.body?.message || e.body?.error || e.message || 'Failed'); }
  };
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{isNew ? 'Add MCP server' : `Edit ${init.name}`}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {err && <Alert severity="error">{err}</Alert>}
          <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} helperText="Lowercase letters, digits, and dashes (max 24). Tools appear to the agent as mcp__name__tool." />
          <TextField label="URL" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://mcp.example.com/mcp" helperText="A remote MCP server using the Streamable HTTP transport." />
          <TextField label="Authentication headers" multiline minRows={2} value={f.headers} onChange={(e) => setF({ ...f, headers: e.target.value })} placeholder="Authorization: Bearer …"
            helperText={init?.headerNames?.length ? `Stored: ${init.headerNames.join(', ')}. Leave blank to keep them; enter new lines to replace; they are never shown again.` : 'One "Name: value" per line. Stored encrypted and never shown again.'} slotProps={{ htmlInput: { 'aria-label': 'Authentication headers' } }} />
          <FormControlLabel control={<Switch checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />} label="Enabled" />
          {admin && <FormControlLabel control={<Switch checked={f.allowPrivate} onChange={(e) => setF({ ...f, allowPrivate: e.target.checked })} />} label="Allow a private/internal address (http allowed)" />}
          {!admin && <Typography variant="caption" color="text.secondary">Your servers must be public https addresses.</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Cancel</Button><Button variant="contained" onClick={submit}>Save</Button></DialogActions>
    </Dialog>
  );
}

function ToolsResult({ r }) {
  if (!r) return null;
  if (!r.ok) return <Alert severity="error" sx={{ mt: 1 }}>{r.error}</Alert>;
  return (
    <Alert severity="success" sx={{ mt: 1 }}>
      Connected. {r.tools.length} tool{r.tools.length === 1 ? '' : 's'}:
      <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ mt: 0.5 }}>{r.tools.map((t) => <Chip key={t.name} size="small" label={t.name} title={t.description} variant={t.readOnly ? 'outlined' : 'filled'} color={t.readOnly ? 'default' : 'warning'} />)}</Stack>
      <Typography variant="caption" component="div" sx={{ mt: 0.5 }}>Outlined = read-only. Others can change things, so the agent needs your approval for each call (and they are unavailable in Plan mode).</Typography>
    </Alert>
  );
}

// A user's MCP servers: the organization's (which they can switch off for themselves) and their own (full control).
export function UserMcpServers() {
  const { can } = useAuth(); const [data, setData] = useState({ tenant: [], own: [], ownAllowed: true });
  const edit = can('profile.mcp.edit') && data.ownAllowed !== false; const [dlg, setDlg] = useState(null); const [msg, setMsg] = useState(null); const [tests, setTests] = useState({});
  const load = useCallback(() => get('/api/mcp/servers').then(setData).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  const act = async (fn, ok) => { try { await fn(); if (ok) setMsg({ s: 'success', t: ok }); load(); } catch (e) { setMsg({ s: 'error', t: e.body?.message || e.body?.error || 'Failed' }); } };
  const toggle = (s, on) => act(() => put(`/api/mcp/servers/${s.id}/enabled`, { enabled: on }));
  const save = async (body, init) => { await (init?.id ? put(`/api/mcp/my-servers/${init.id}`, body) : post('/api/mcp/my-servers', body)); setDlg(null); setMsg({ s: 'success', t: 'Saved' }); load(); };
  const test = async (s) => { setTests((t) => ({ ...t, [s.id]: undefined })); const r = await post(`/api/mcp/my-servers/${s.id}/test`).catch((e) => ({ ok: false, error: e.body?.error || 'Failed' })); setTests((t) => ({ ...t, [s.id]: r })); };
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>MCP servers give the agent extra tools (documentation search, ticketing, databases…). Tools a server does not mark read-only are unavailable in Plan mode and need your approval each time in Act mode.</Typography>
      {msg && <Alert severity={msg.s} sx={{ mb: 1 }} onClose={() => setMsg(null)}>{msg.t}</Alert>}
      <Typography variant="subtitle2">From your organization</Typography>
      {!data.tenant.length && <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>None configured.</Typography>}
      {data.tenant.map((s) => (
        <Paper key={s.id} variant="outlined" sx={{ p: 1.5, mb: 1 }} data-testid="mcp-tenant">
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography sx={{ fontFamily: 'monospace', fontWeight: 600 }}>{s.name}</Typography><Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>{hostOf(s.url)}</Typography>
            <FormControlLabel sx={{ mr: 0 }} label="Use" control={<Switch size="small" checked={!s.disabledByMe} onChange={(e) => toggle(s, e.target.checked)} slotProps={{ input: { 'aria-label': `Use ${s.name}` } }} />} />
          </Stack>
        </Paper>))}
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 2 }}><Typography variant="subtitle2" sx={{ flexGrow: 1 }}>Your own servers</Typography>{edit && <Button variant="outlined" onClick={() => setDlg({})}>Add server</Button>}</Stack>
      {data.ownAllowed === false && <Alert severity="info" sx={{ my: 1 }}>Your administrator has turned off personal MCP servers. Yours are not used by the agent.</Alert>}
      {!data.own.length && <Typography variant="body2" color="text.secondary">None yet.</Typography>}
      {data.own.map((s) => (
        <Paper key={s.id} variant="outlined" sx={{ p: 1.5, my: 1 }} data-testid="mcp-own">
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography sx={{ fontFamily: 'monospace', fontWeight: 600 }}>{s.name}</Typography><Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>{hostOf(s.url)}</Typography>
            <Switch size="small" checked={s.enabled} disabled={!edit} onChange={(e) => toggle(s, e.target.checked)} slotProps={{ input: { 'aria-label': `Enable ${s.name}` } }} />
            {edit && <><Button size="small" onClick={() => test(s)}>Test</Button><Button size="small" onClick={() => setDlg(s)}>Edit</Button><Button size="small" color="error" onClick={() => window.confirm(`Delete ${s.name}?`) && act(() => del(`/api/mcp/my-servers/${s.id}`), 'Deleted')}>Delete</Button></>}
          </Stack>
          <ToolsResult r={tests[s.id]} />
        </Paper>))}
      {dlg && <McpServerDialog init={dlg} onClose={() => setDlg(null)} onSave={save} />}
    </Box>
  );
}
