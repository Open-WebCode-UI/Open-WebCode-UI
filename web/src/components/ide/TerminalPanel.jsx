import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Stack, Tab, Tabs, Typography } from '@mui/material';
import { get, post, del } from '../../api.js';
import { useStepUp } from '../StepUp.jsx';
import ApprovalPrompt from '../ApprovalPrompt.jsx';
import ShellTerminal from './ShellTerminal.jsx';

const Notice = ({ children, action }) => <Box sx={{ p: 2, color: '#9aa1ab', bgcolor: '#14161a', height: '100%' }}><Typography variant="body2" sx={{ mb: 1 }}>{children}</Typography>{action}</Box>;

// Terminal pane: "Terminal" is an interactive shell you type into; "Agent" is a live, read-only view of the shell the agent
// uses (every command it runs needs your Allow, shown here and in the chat).
export default function TerminalPanel({ project, refreshKey }) {
  const { run, dialog } = useStepUp();
  const [tab, setTab] = useState('user'); const [status, setStatus] = useState(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(() => (project ? get(`/api/terminal/status?projectId=${project.id}`).then(setStatus).catch(() => setStatus(null)) : setStatus(null)), [project]);
  useEffect(() => { load(); }, [load, refreshKey]);
  // The agent's shell appears only once its first command is approved: while the Agent tab is open and empty, keep looking so you can watch that command run.
  const waitingForAgent = tab === 'agent' && status?.enabled && status.canView && !status.agentSession;
  useEffect(() => { if (!waitingForAgent) return undefined; const t = setInterval(load, 1500); return () => clearInterval(t); }, [waitingForAgent, load]);

  const start = async () => {
    setErr(''); setBusy(true);
    try { await run(() => post('/api/terminal/sessions', { projectId: project.id })); await load(); }
    catch (e) { if (e.message !== 'canceled') setErr(e.body?.error === 'too_many_terminals' ? 'You have too many open terminals. Close one first.' : e.body?.message || e.body?.error || 'Could not start the terminal'); }
    finally { setBusy(false); }
  };
  const stop = async () => { if (status?.userSession) await del(`/api/terminal/sessions/${status.userSession}`).catch(() => {}); load(); };

  const body = () => {
    if (!project) return <Notice>Select a project to use the terminal.</Notice>;
    if (!status) return <Notice>Loading…</Notice>;
    if (!status.enabled) return <Notice>Shell access is turned off. An administrator can enable it under Admin → General → Agent execution mode ("Server-side workspace with approval-gated shell").</Notice>;
    if (tab === 'agent') {
      if (!status.canView) return <Notice>Your role cannot view the agent's shell.</Notice>;
      return status.agentSession ? <ShellTerminal key={status.agentSession} sessionId={status.agentSession} readOnly />
        : <Notice action={<Button size="small" color="inherit" onClick={load}>Check again</Button>}>The agent has not run any commands in this project yet. When it does, you will watch them run here and approve each one.</Notice>;
    }
    if (!status.canUse) return <Notice>Your role cannot use the interactive terminal (permission “terminal.use”).</Notice>;
    return status.userSession ? <ShellTerminal key={status.userSession} sessionId={status.userSession} onEnded={load} />
      : <Notice action={<Button variant="outlined" color="inherit" size="small" disabled={busy} onClick={start}>Start terminal</Button>}>A shell in this project's folder on the server. It runs with the server's operating-system account, so treat it like any shell on that machine.</Notice>;
  };

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: '#14161a' }}>
      <Stack direction="row" alignItems="center" sx={{ borderBottom: '1px solid #2a2d33', bgcolor: 'background.paper' }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ minHeight: 30, flexGrow: 1 }}>
          <Tab value="user" label="Terminal" sx={{ minHeight: 30, py: 0 }} /><Tab value="agent" label="Agent" sx={{ minHeight: 30, py: 0 }} />
        </Tabs>
        {status?.userSession && tab === 'user' && <Button size="small" color="inherit" onClick={stop} sx={{ mr: 1, fontSize: 11 }}>Close terminal</Button>}
      </Stack>
      <ApprovalPrompt dense />
      {err && <Alert severity="error" onClose={() => setErr('')} sx={{ borderRadius: 0, py: 0 }}>{err}</Alert>}
      <Box sx={{ flexGrow: 1, minHeight: 0 }}>{body()}</Box>
      {dialog}
    </Box>
  );
}
