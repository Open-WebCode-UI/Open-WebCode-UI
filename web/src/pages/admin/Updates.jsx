import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import { get, post } from '../../api.js';
import { useAuth } from '../../AuthContext.jsx';
import { useStepUp } from '../../components/StepUp.jsx';
import { errText } from './common.jsx';

// Shows the installed and newest releases, checks for a newer one, and installs it after a step-up confirmation.
export default function Updates() {
  const { can } = useAuth(); const writable = can('settings.write');
  const { run, dialog } = useStepUp();
  const [st, setSt] = useState(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(null);

  const load = useCallback(() => get('/api/admin/update').then(setSt).catch((e) => setMsg({ s: 'error', t: errText(e) })), []);
  useEffect(() => { load(); }, [load]);

  // While an update runs, poll its progress.
  const running = st?.job?.state === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [running, load]);

  const check = async () => {
    setBusy(true); setMsg(null);
    try { setSt(await post('/api/admin/update/check', {})); }
    catch (e) { setMsg({ s: 'error', t: errText(e) }); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    setMsg(null);
    try { setSt(await run(() => post('/api/admin/update/apply', {}))); setMsg({ s: 'info', t: 'Update started. Progress appears below.' }); }
    catch (e) { if (e.message !== 'canceled') setMsg({ s: 'error', t: `Not updated: ${errText(e)}` }); }
  };

  if (!st) return msg ? <Alert severity={msg.s}>{msg.t}</Alert> : null;
  const job = st.job;
  const canApply = writable && st.isCheckout && st.updateAvailable && !running && st.dirty === false;
  const blocked = !st.isCheckout ? 'This server was not installed from a git checkout, so it cannot update itself. Reinstall it from the repository.'
    : st.dirty ? 'Tracked files have local changes. Commit or discard them before updating.' : null;

  return (
    <Box>
      <Typography variant="h5" component="h1" gutterBottom>Updates</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Check the release repository for a newer version (releases are tagged with semantic versions, such as 1.2.0), and install it on this server.</Typography>
      <Stack spacing={2}>
        {msg && <Alert severity={msg.s} onClose={() => setMsg(null)}>{msg.t}</Alert>}
        {st.restartRequired && <Alert severity="warning">The update is installed. Restart the server to run version {st.currentVersion}.</Alert>}
        {job?.state === 'succeeded' && !st.restartRequired && <Alert severity="success">Updated to {job.to}.</Alert>}
        {job?.state === 'failed' && <Alert severity="error">The update to {job.to} failed{job.rolledBack ? ', and the previous version is still in place' : ''}. {job.error}</Alert>}
        {blocked && <Alert severity="info">{blocked}</Alert>}

        <Paper variant="outlined" sx={{ p: 2 }} component="section" aria-label="Versions">
          <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'max-content minmax(0,1fr)', columnGap: 2, rowGap: 0.5 }}>
            <Typography component="dt" variant="body2" color="text.secondary">Installed</Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0 }}>{st.currentVersion}</Typography>
            <Typography component="dt" variant="body2" color="text.secondary">Newest release</Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0 }}>{st.latest ?? 'Not checked yet'}</Typography>
            <Typography component="dt" variant="body2" color="text.secondary">Last checked</Typography>
            <Typography component="dd" variant="body2" sx={{ m: 0 }}>{st.checkedAt ? new Date(st.checkedAt).toLocaleString() : 'Never'}</Typography>
          </Box>
          {st.updateAvailable && <Typography variant="body2" sx={{ mt: 2 }}>A {st.updateType} update is available: {st.latest}.</Typography>}
          {!st.updateAvailable && st.latest && <Typography variant="body2" sx={{ mt: 2 }}>This server is up to date.</Typography>}
        </Paper>

        <Stack direction="row" spacing={1}>
          <Button variant="outlined" onClick={check} disabled={busy || running}>Check for updates</Button>
          {writable && <Button variant="contained" onClick={apply} disabled={!canApply}>Install update</Button>}
        </Stack>
        {writable && <Typography variant="caption" color="text.secondary">Installing asks you for a multi-factor code first. The server keeps running the old code until it is restarted.</Typography>}

        {job && (
          <Paper variant="outlined" sx={{ p: 2 }} component="section" aria-label="Update progress">
            <Typography variant="subtitle1" gutterBottom>{job.state === 'running' ? `Updating to ${job.to}` : `Last update: ${job.to}`}</Typography>
            <Box component="pre" sx={{ m: 0, maxHeight: 240, overflow: 'auto', fontFamily: 'monospace', fontSize: '0.8rem', whiteSpace: 'pre-wrap' }}>{job.log.join('\n')}</Box>
          </Paper>
        )}
      </Stack>
      {dialog}
    </Box>
  );
}
