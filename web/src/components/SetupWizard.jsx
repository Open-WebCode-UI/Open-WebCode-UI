import { useEffect, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Step, StepLabel, Stepper, Switch, TextField, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { get, post } from '../api.js';
import { useAuth } from '../AuthContext.jsx';

const STEPS = ['Identity', 'Features', 'Finish'];
const FEATURES = [
  ['memoryAllowed', 'Agent memory', 'Lets users and projects opt in to saved notes. Off here disables it for everyone.'],
  ['coursesEnabled', 'Courses', 'Shows the Courses page and the Course Design chat tab.'],
  ['userMcpAllowed', 'Personal MCP servers', 'Lets users add their own remote tool servers.'],
  ['showSessionCost', 'Show session cost', 'Shows every user what each session costs.'],
];

// Shown to an administrator on first load until it is finished or skipped. Only low-risk choices live here; the rest stay on their Admin pages.
export default function SetupWizard({ onActive }) {
  const { can, refresh } = useAuth();
  const [info, setInfo] = useState(null);
  const [v, setV] = useState(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const eligible = can('settings.write');

  useEffect(() => {
    if (!eligible) return undefined;
    let live = true;
    get('/api/admin/setup').then((s) => { if (live) { setInfo(s); setV(s.values); } }, () => {});
    return () => { live = false; };
  }, [eligible]);

  const open = eligible && !!info && !info.completed;
  useEffect(() => { onActive?.(open); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open) return null;

  const set = (k) => (e) => setV((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const finish = async (skip) => {
    setBusy(true); setError('');
    try {
      await post('/api/admin/setup/complete', skip ? { skip: true } : { choices: { ...v, appName: v.appName.trim() } });
      setInfo((i) => ({ ...i, completed: true }));
      if (!skip) await refresh();
    } catch (e) { setError(e.body?.issues?.[0]?.message || 'Could not save the setup. Try again.'); }
    setBusy(false);
  };

  return (
    <Dialog open fullWidth maxWidth="sm" aria-labelledby="setup-title">
      <DialogTitle id="setup-title">Welcome — let's set things up</DialogTitle>
      <DialogContent>
        <Stepper activeStep={step} sx={{ mb: 3 }}>{STEPS.map((s) => <Step key={s}><StepLabel>{s}</StepLabel></Step>)}</Stepper>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {step === 0 && (
          <Box sx={{ display: 'grid', gap: 2 }}>
            <TextField label="Application name" value={v.appName} onChange={set('appName')} error={!v.appName.trim()} helperText={!v.appName.trim() ? 'Required' : ' '} />
            <TextField label="Tagline" value={v.tagline} onChange={set('tagline')} />
            {can('branding.write') && <>
              <TextField label="Brand color" type="color" value={v.primaryColor} onChange={set('primaryColor')} slotProps={{ inputLabel: { shrink: true } }} />
              <TextField select label="Default appearance" value={v.defaultMode} onChange={set('defaultMode')}>
                <MenuItem value="system">Follow the device</MenuItem><MenuItem value="light">Light</MenuItem><MenuItem value="dark">Dark</MenuItem>
              </TextField>
            </>}
          </Box>
        )}
        {step === 1 && (
          <Box sx={{ display: 'grid', gap: 1 }}>
            {FEATURES.map(([k, label, help]) => (
              <Box key={k}><FormControlLabel control={<Switch checked={!!v[k]} onChange={set(k)} />} label={label} /><Typography variant="body2" color="text.secondary" sx={{ ml: 6, mt: -0.5 }}>{help}</Typography></Box>
            ))}
          </Box>
        )}
        {step === 2 && (
          <Box sx={{ display: 'grid', gap: 2 }}>
            {info.modelCount === 0
              ? <Alert severity="warning">No AI model is connected yet. Nobody can use the agent or chat until you add one under <RouterLink to="/admin/servers" onClick={() => finish(false)}>Server (AI services)</RouterLink>.</Alert>
              : <Alert severity="success">{info.modelCount} AI model{info.modelCount === 1 ? '' : 's'} connected.</Alert>}
            <Alert severity="info">Shell execution ({info.execMode === 'files_only' ? 'currently off' : 'on'}), sign-in security, SSO, HTTPS and web search are not changed here. Find them in the Admin area when you need them.</Alert>
            <Typography variant="body2">Everything above can be changed later under Admin.</Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => finish(true)} disabled={busy} sx={{ mr: 'auto' }}>Skip setup</Button>
        <Button onClick={() => setStep(step - 1)} disabled={busy || step === 0}>Back</Button>
        {step < STEPS.length - 1
          ? <Button variant="contained" onClick={() => setStep(step + 1)} disabled={!v.appName.trim()}>Next</Button>
          : <Button variant="contained" onClick={() => finish(false)} disabled={busy}>Finish</Button>}
      </DialogActions>
    </Dialog>
  );
}
