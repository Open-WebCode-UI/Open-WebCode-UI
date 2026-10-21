import { useEffect, useRef, useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// A real terminal (xterm.js) attached to a server-side shell over a WebSocket. With readOnly it only mirrors the output
// (used for the agent's shell, which the user watches but does not type into).
export default function ShellTerminal({ sessionId, readOnly = false, onEnded }) {
  const host = useRef(null);
  const [state, setState] = useState('connecting'); // connecting | open | closed
  const [attempt, setAttempt] = useState(0);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!sessionId || !host.current) return undefined;
    setState('connecting'); setReason('');
    const term = new Terminal({ cursorBlink: !readOnly, disableStdin: readOnly, fontSize: 12, fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace', scrollback: 5000, theme: { background: '#14161a', foreground: '#d6d9de' }, allowProposedApi: false });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current);
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/api/terminal/ws?id=${encodeURIComponent(sessionId)}`);
    const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
    const resize = () => { try { fit.fit(); send({ type: 'resize', cols: term.cols, rows: term.rows }); } catch { /* not laid out yet */ } };
    ws.onopen = () => { setState('open'); resize(); if (!readOnly) term.focus(); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'output') term.write(m.data);
      else if (m.type === 'exit') { term.write('\r\n\x1b[2m[shell exited]\x1b[0m\r\n'); onEnded?.(m.code); }
      else if (m.type === 'closed') setReason(m.reason === 'access_revoked' ? 'Your access to the terminal ended.' : '');
    };
    ws.onclose = () => setState('closed');
    ws.onerror = () => setState('closed');
    const input = readOnly ? null : term.onData((d) => send({ type: 'input', data: d }));
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null; ro?.observe(host.current);
    return () => { ro?.disconnect(); input?.dispose(); ws.onclose = null; ws.close(); term.dispose(); };
  }, [sessionId, readOnly, attempt]); // eslint-disable-line

  return (
    <Box sx={{ position: 'relative', height: '100%', bgcolor: '#14161a', p: 0.5 }}>
      <Box ref={host} data-testid="xterm-host" aria-label={readOnly ? "Agent's shell (read-only)" : 'Terminal'} sx={{ height: '100%', '& .xterm-viewport': { overflowY: 'auto' } }} />
      {state === 'closed' && (
        <Stack direction="row" alignItems="center" spacing={1} sx={{ position: 'absolute', right: 8, top: 8, bgcolor: 'rgba(0,0,0,.7)', color: '#d6d9de', px: 1, py: 0.5, borderRadius: 1 }}>
          <Typography variant="caption">{reason || 'Disconnected'}</Typography>
          <Button size="small" color="inherit" onClick={() => setAttempt((a) => a + 1)}>Reconnect</Button>
        </Stack>)}
    </Box>
  );
}
