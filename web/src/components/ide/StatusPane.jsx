import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Stack } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { get } from '../../api.js';
import { StatusCard } from '../AgentItems.jsx';

// Platform status: the connection, model server, server, user, and project, the same facts as the /status command, kept on screen.
export default function StatusPane({ project }) {
  const pid = project?.id;
  const [status, setStatus] = useState(null); const [err, setErr] = useState(false); const [loading, setLoading] = useState(false);
  const load = useCallback(() => {
    setLoading(true);
    return get(`/api/agent/status${pid ? `?projectId=${pid}` : ''}`).then((s) => { setStatus(s); setErr(false); }, () => setErr(true)).finally(() => setLoading(false));
  }, [pid]);
  useEffect(() => { load(); }, [load]);
  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 1 }}>
      <Stack direction="row" justifyContent="flex-end" sx={{ mb: 1 }}>
        <Button size="small" startIcon={loading ? <CircularProgress size={14} /> : <RefreshIcon />} disabled={loading} onClick={load}>Refresh</Button>
      </Stack>
      {err && <Alert severity="error" sx={{ mb: 1 }}>Could not load the platform status.</Alert>}
      {status && <StatusCard s={status} />}
    </Box>
  );
}
