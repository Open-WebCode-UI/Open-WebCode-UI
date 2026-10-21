import { useEffect, useState } from 'react';
import { TextField, FormControlLabel, Switch, Button, Alert, Stack, MenuItem, Typography, Box } from '@mui/material';
import { get, put } from '../../api.js';
import { useStepUp } from '../../components/StepUp.jsx';

export const errText = (e) => e?.body?.issues ? e.body.issues.map((i) => `${i.path}: ${i.message}`).join('; ') : e?.body?.error || e?.message || 'Failed';

// Loads a settings group, renders `children(form, set)` and saves with step-up handling.
export function SettingsPage({ title, url, readOnly, children, transform = (x) => x, intro, onSaved }) {
  const [form, setForm] = useState(null); const [msg, setMsg] = useState(null); const [saveMsg, setSaveMsg] = useState(null);
  const { run, dialog } = useStepUp();
  useEffect(() => { get(url).then((d) => setForm(transform(d))).catch((e) => setMsg({ s: 'error', t: errText(e) })); }, [url]); // eslint-disable-line
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    setSaveMsg(null);
    try { const r = await run(() => put(url, form)); setForm(transform(r)); setSaveMsg({ s: 'success', t: 'Settings saved.' }); onSaved?.(r); } catch (e) { if (e.message !== 'canceled') setSaveMsg({ s: 'warning', t: `Settings were not saved: ${errText(e)}` }); }
  };
  if (!form) return msg ? <Alert severity="error">{msg.t}</Alert> : null;
  return (
    <Box>
      <Typography variant="h5" gutterBottom>{title}</Typography>
      {intro && <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{intro}</Typography>}
      {msg && <Alert severity={msg.s} sx={{ mb: 2 }} onClose={() => setMsg(null)}>{msg.t}</Alert>}
      <Stack spacing={2}>{children(form, set)}
        {!readOnly && saveMsg && <Alert severity={saveMsg.s} onClose={() => setSaveMsg(null)}>{saveMsg.t}</Alert>}
        {!readOnly && <Box><Button variant="contained" onClick={save}>Save</Button></Box>}
      </Stack>
      {dialog}
    </Box>
  );
}

export const Text = ({ label, value, onChange, ...p }) => <TextField fullWidth size="small" label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...p} />;
export const Num = ({ label, value, onChange, ...p }) => <TextField fullWidth size="small" type="number" label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} {...p} />;
export const Bool = ({ label, value, onChange }) => <FormControlLabel control={<Switch checked={!!value} onChange={(e) => onChange(e.target.checked)} />} label={label} />;
export const Pick = ({ label, value, onChange, options, helperText }) => <TextField select fullWidth size="small" label={label} value={value ?? ''} helperText={helperText} onChange={(e) => onChange(e.target.value)}>{options.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}</TextField>;
export const Lines = ({ label, value, onChange, ...p }) => <TextField fullWidth size="small" multiline minRows={2} label={label} value={(value || []).join('\n')} onChange={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))} {...p} />;
