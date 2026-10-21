import { useEffect, useState } from 'react';
import { Paper, Stack, Typography, LinearProgress, CircularProgress } from '@mui/material';

export const fmtDuration = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
// Share of the wait that is probably done: roughly linear at first, then slowing so the bar never reaches 100% before the model answers.
export const prefillPercent = (elapsedMs, etaMs) => Math.round(95 * (1 - Math.exp((-2.3 * elapsedMs) / etaMs)));
const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

// Shown in place of the agent's reply while the model reads the prompt, when nothing else on screen changes. Local servers send
// no progress during this phase, so this is a live timer plus an estimate learned from earlier requests (see server/src/agent/prefill.js).
export default function TurnStatus({ phase, who = 'Agent' }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, [phase?.since]);
  if (!phase) return null;
  const elapsed = Math.max(0, now - phase.since);
  const prefill = phase.name === 'prefill', eta = prefill ? phase.etaMs : null;
  const label = !prefill ? 'Sending…' : `Processing prompt${phase.tokens ? ` (~${fmtTokens(phase.tokens)} tokens) - this may take some time` : ''}…`;
  const detail = eta ? (elapsed > eta ? 'taking longer than estimated' : `about ${fmtDuration(eta - elapsed)} left`) : null;
  return (
    <Paper variant="outlined" data-testid="turn-status" role="status" sx={{ p: 1.5 }}>
      <Typography variant="caption" color="text.secondary">{who}</Typography>
      <Stack direction="row" spacing={1} alignItems="baseline">
        <Typography variant="body2" sx={{ flexGrow: 1 }}>{label}</Typography>
        <Typography variant="caption" color="text.secondary" data-testid="turn-elapsed">{fmtDuration(elapsed)}{detail ? ` · ${detail}` : ''}</Typography>
      </Stack>
      <LinearProgress sx={{ mt: 1 }} {...(eta ? { variant: 'determinate', value: elapsed > eta ? 95 : prefillPercent(elapsed, eta) } : {})} aria-label="Prompt processing" />
    </Paper>
  );
}

// Between visible events the model is still generating. Some servers (LM Studio, for one) hold a tool call back until it is fully
// written, so a long file can leave nothing on screen for a while; this says so, with the time since the last update.
export function QuietNote({ since, show }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!show) return undefined; const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, [show]);
  const quiet = now - since;
  if (!show || quiet < 2500) return null;
  return (
    <Paper variant="outlined" data-testid="quiet-note" role="status" sx={{ p: 1, ml: 2 }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <CircularProgress size={14} />
        <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>The model is still writing. Some model servers only send a file or command once it is complete.</Typography>
        <Typography variant="caption" color="text.secondary">{fmtDuration(quiet)}</Typography>
      </Stack>
    </Paper>
  );
}

// Inside a tool card that has been named but has no content yet. Servers that send a call only once it is complete (LM Studio, for one)
// leave it like this for as long as the model takes to write the whole file; say so, with the time spent waiting.
export function WaitingNote({ since, children }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);
  const waited = now - (since ?? now);
  return (
    <Stack direction="row" spacing={1} alignItems="center" data-testid="waiting-note">
      <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
        {waited < 2500 ? children : 'The model is writing this, but its server only sends it once it is complete, so nothing can be shown until then.'}
      </Typography>
      {waited >= 2500 && <Typography variant="caption" color="text.secondary">{fmtDuration(waited)}</Typography>}
    </Stack>
  );
}
