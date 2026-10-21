import { useEffect, useState } from 'react';
import { FormControlLabel, Switch, Tooltip } from '@mui/material';
import { get } from '../api.js';
import { useAuth } from '../AuthContext.jsx';

// The tenant switch, whether a search service exists, and the user's own switch. Null until known (or without the permission).
export function useWebSearchStatus() {
  const { can } = useAuth();
  const permitted = can('websearch.use');
  const [status, setStatus] = useState(null);
  useEffect(() => { if (permitted) get('/api/web-search').then(setStatus).catch(() => {}); }, [permitted]);
  return permitted ? status : null;
}

export const whyWebSearchOff = (s) => (!s.allowed ? 'An administrator has turned web search off.' : !s.configured ? 'No search service is configured. Ask an administrator.' : !s.enabled ? 'Web search is switched off in your profile.' : '');

// Per-chat switch. Shown only to people who may use web search; disabled, with the reason, when the tenant or profile has it off.
export default function WebSearchToggle({ value, onChange, disabled }) {
  const s = useWebSearchStatus();
  if (!s) return null;
  const why = whyWebSearchOff(s);
  const control = (
    <FormControlLabel sx={{ mr: 0, flexShrink: 0 }} label="Web search" slotProps={{ typography: { variant: 'body2' } }}
      control={<Switch size="small" checked={!why && !!value} disabled={disabled || !!why} onChange={(e) => onChange(e.target.checked)} slotProps={{ input: { 'aria-label': 'Web search' } }} />} />
  );
  return why ? <Tooltip title={why}><span>{control}</span></Tooltip> : control;
}
