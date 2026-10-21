import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, FormControlLabel, Paper, Stack, Switch, Typography } from '@mui/material';
import { get, post, put, del } from '../../api.js';
import { useAuth } from '../../AuthContext.jsx';
import { useStepUp } from '../../components/StepUp.jsx';
import { McpServerDialog } from '../../components/McpServers.jsx';

// organization-wide MCP servers. Everyone gets these tools unless they switch a server off for themselves (Profile → MCP servers).
export default function McpServers() {
  const { can } = useAuth(); const write = can('mcp.write');
  const { run, dialog } = useStepUp();
  const canSettings = can('settings.write'); const [userAllowed, setUserAllowed] = useState(null);
  const [rows, setRows] = useState([]); const [dlg, setDlg] = useState(null); const [msg, setMsg] = useState(null); const [tests, setTests] = useState({});
  const load = useCallback(() => get('/api/admin/mcp-servers').then(setRows).catch((e) => setMsg({ s: 'error', t: e.body?.error || 'Failed to load' })), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { get('/api/admin/general').then((g) => setUserAllowed(!!g.userMcpAllowed)).catch(() => {}); }, []);
  const setAllowed = async (v) => { try { await run(() => put('/api/admin/general', { userMcpAllowed: v })); setUserAllowed(v); setMsg({ s: 'success', t: v ? 'Users can connect their own MCP servers' : 'Users can no longer use their own MCP servers' }); } catch (e) { if (e.message !== 'canceled') setMsg({ s: 'error', t: e.body?.message || e.body?.error || 'Failed' }); } };
  const act = async (fn, ok) => { try { await run(fn); setMsg({ s: 'success', t: ok }); load(); } catch (e) { if (e.message !== 'canceled') setMsg({ s: 'error', t: e.body?.message || e.body?.error || 'Failed' }); } };
  const save = async (body, init) => { await run(() => (init?.id ? put(`/api/admin/mcp-servers/${init.id}`, body) : post('/api/admin/mcp-servers', body))); setDlg(null); setMsg({ s: 'success', t: 'Saved' }); load(); };
  const test = async (s) => { setTests((t) => ({ ...t, [s.id]: undefined })); const r = await post(`/api/admin/mcp-servers/${s.id}/test`).catch((e) => ({ ok: false, error: e.body?.error || 'Failed' })); setTests((t) => ({ ...t, [s.id]: r })); };
  return (
    <Box>
      <Typography variant="h5" gutterBottom>MCP servers</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Remote Model Context Protocol servers whose tools are offered to every user's agent. Each user can switch a server off for themselves; users can also add their own servers in their profile. Credentials are stored encrypted. Tools that are not marked read-only need the user's approval on every call.</Typography>
      {msg && <Alert severity={msg.s} sx={{ mb: 2 }} onClose={() => setMsg(null)}>{msg.t}</Alert>}
      {userAllowed !== null && (
        <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
          <FormControlLabel control={<Switch checked={userAllowed} disabled={!canSettings} onChange={(e) => setAllowed(e.target.checked)} />} label="Allow users to connect their own MCP servers (Profile → MCP servers)" />
          <Typography variant="caption" color="text.secondary" component="div">When off, users cannot add, edit, or test personal servers and their existing ones are not offered to the agent. Organization servers below are unaffected.</Typography>
        </Paper>)}
      {write && <Button variant="contained" sx={{ mb: 2 }} onClick={() => setDlg({})}>Add server</Button>}
      {!rows.length && <Typography color="text.secondary">No organization servers yet.</Typography>}
      {rows.map((s) => (
        <Paper key={s.id} variant="outlined" sx={{ p: 1.5, mb: 1 }} data-testid="mcp-admin-row">
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography sx={{ fontFamily: 'monospace', fontWeight: 600 }}>{s.name}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1, minWidth: 0 }} noWrap>{s.url}</Typography>
            {s.allowPrivate && <Chip size="small" color="warning" variant="outlined" label="private address" />}
            {s.headerNames.length > 0 && <Chip size="small" variant="outlined" label={`headers: ${s.headerNames.join(', ')}`} />}
            <Switch size="small" checked={s.enabled} disabled={!write} onChange={(e) => act(() => put(`/api/admin/mcp-servers/${s.id}`, { enabled: e.target.checked }), 'Updated')} slotProps={{ input: { 'aria-label': `Enable ${s.name}` } }} />
            {write && <><Button size="small" onClick={() => test(s)}>Test</Button><Button size="small" onClick={() => setDlg(s)}>Edit</Button><Button size="small" color="error" onClick={() => window.confirm(`Delete ${s.name}?`) && act(() => del(`/api/admin/mcp-servers/${s.id}`), 'Deleted')}>Delete</Button></>}
          </Stack>
          {tests[s.id] && (tests[s.id].ok ? <Alert severity="success" sx={{ mt: 1 }}>Connected: {tests[s.id].tools.length} tools ({tests[s.id].tools.map((t) => t.name).join(', ') || 'none'})</Alert> : <Alert severity="error" sx={{ mt: 1 }}>{tests[s.id].error}</Alert>)}
        </Paper>))}
      {dlg && <McpServerDialog init={dlg} admin onClose={() => setDlg(null)} onSave={save} />}
      {dialog}
    </Box>
  );
}
