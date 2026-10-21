import { Alert, Button, Stack } from '@mui/material';

const fmt = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

// Suggests compacting or clearing when the session is filling the model's context window.
export default function ContextBanner({ context, busy, onCompact, onClear, onNew }) {
  if (!context || context.level === 'ok') return null;
  const high = context.level === 'high';
  return (
    <Alert severity={high ? 'warning' : 'info'} data-testid="context-banner" data-level={context.level} sx={{ alignItems: 'center', borderRadius: 0, py: 0 }}
      action={<Stack direction="row" spacing={0.5}><Button size="small" color="inherit" variant="outlined" disabled={busy} onClick={onCompact}>Compact</Button><Button size="small" color="inherit" disabled={busy} onClick={onClear}>Clear</Button><Button size="small" color="inherit" disabled={busy} onClick={onNew}>New session</Button></Stack>}>
      {high ? 'This session is almost full' : 'This session is getting long'} (about {fmt(context.tokens)} of {fmt(context.limit)} tokens, {context.pct}%). {high ? 'Compact it now to keep going' : 'Compact it to keep the gist and free up space'}, clear it to start over, or open a new session.
    </Alert>
  );
}
