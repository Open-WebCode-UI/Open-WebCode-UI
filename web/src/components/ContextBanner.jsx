import { useEffect, useState } from 'react';
import { Alert, Box, Button, IconButton, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

// How full the model's context window is, to one decimal place (the server counts the tokens; see contextInfo in sessions.js).
export const exactPct = (c) => (c.limit ? Math.round((c.tokens / c.limit) * 1000) / 10 : 0);
const num = (n) => Number(n).toLocaleString();

// The context window as a pie: the part in use is coloured, the rest is grey.
export function ContextPie({ pct, high }) {
  const share = Math.min(Math.max(pct, 0), 100) / 100;
  const angle = 2 * Math.PI * share;
  // Clockwise from the top of the circle to the point at `angle`.
  const end = `${10 + 9 * Math.sin(angle)} ${10 - 9 * Math.cos(angle)}`;
  return (
    <Box component="svg" viewBox="0 0 20 20" role="img" aria-label={`Context ${pct.toFixed(1)}% full`} sx={{ width: 22, height: 22, flexShrink: 0, color: high ? 'warning.main' : 'info.main' }}>
      <circle cx="10" cy="10" r="9" fill="currentColor" opacity="0.18" />
      {share >= 1 ? <circle cx="10" cy="10" r="9" fill="currentColor" />
        : share > 0 ? <path d={`M10 10 L10 1 A9 9 0 ${share > 0.5 ? 1 : 0} 1 ${end} Z`} fill="currentColor" />
        : null}
    </Box>
  );
}

// Shows how full the session's context window is. Over half full: a pie and its exact numbers.
// Over 80% full: a warning above the message box, which can be dismissed until the context drops back below 80%.
export default function ContextBanner({ context, busy, onCompact, onClear, onNew }) {
  const [dismissed, setDismissed] = useState(false);
  const level = context?.level;
  useEffect(() => { if (level !== 'high') setDismissed(false); }, [level]);
  if (!context || level === 'ok') return null;
  const high = level === 'high', pct = exactPct(context);
  const numbers = `${pct.toFixed(1)}% full (${num(context.tokens)} of ${num(context.limit)} tokens)`;
  return (
    <Stack data-testid="context-level" data-level={level}>
      <Stack direction="row" spacing={1} alignItems="center" data-testid="context-pie" sx={{ px: 1.5, py: 0.5 }}>
        <ContextPie pct={pct} high={high} />
        <Typography variant="caption" color="text.secondary">Context {numbers}</Typography>
      </Stack>
      {high && !dismissed && (
        <Alert severity="warning" data-testid="context-banner" data-level={level} sx={{ alignItems: 'center', borderRadius: 0, py: 0 }}
          action={<Stack direction="row" spacing={0.5} alignItems="center">
            <Button size="small" color="inherit" variant="outlined" disabled={busy} onClick={onCompact}>Compact</Button>
            <Button size="small" color="inherit" disabled={busy} onClick={onClear}>Clear</Button>
            <Button size="small" color="inherit" disabled={busy} onClick={onNew}>New session</Button>
            <IconButton size="small" color="inherit" aria-label="Dismiss context warning" onClick={() => setDismissed(true)}><CloseIcon fontSize="small" /></IconButton>
          </Stack>}>
          This session is {numbers}. Type <code>/compact</code> to summarize it and free up space, or clear it to start over.
        </Alert>
      )}
    </Stack>
  );
}
