import { useState } from 'react';
import { Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Typography, Alert } from '@mui/material';
import { post } from '../api.js';

// Runs `action()`; if the server demands step-up re-verification, prompts for a code and retries.
export function useStepUp() {
  const [pending, setPending] = useState(null);
  const run = (action) => new Promise((resolve, reject) => {
    action().then(resolve).catch((e) => {
      if (e?.body?.error === 'mfa_required') setPending({ action, resolve, reject, method: e.body.method });
      else reject(e);
    });
  });
  const dialog = pending && (
    <StepUpDialog method={pending.method} onCancel={() => { pending.reject(new Error('canceled')); setPending(null); }}
      onDone={() => { const p = pending; setPending(null); p.action().then(p.resolve).catch(p.reject); }} />
  );
  return { run, dialog };
}

function StepUpDialog({ method, onDone, onCancel }) {
  const [code, setCode] = useState(''); const [err, setErr] = useState('');
  const submit = async () => {
    try {
      const r = await post('/api/auth/stepup', { code });
      if (r.reauth) { window.location.href = r.reauth; return; }
      onDone();
    } catch { setErr('Invalid code'); }
  };
  return (
    <Dialog open onClose={onCancel}>
      <DialogTitle>Confirm it's you</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 2 }}>
          {method === 'saml' ? 'You will be sent to your identity provider to re-authenticate.' : 'Enter a code from your authenticator app (or a recovery code) to continue with this sensitive action.'}
        </Typography>
        {err && <Alert severity="error" sx={{ mb: 1 }}>{err}</Alert>}
        {method !== 'saml' && <TextField autoFocus fullWidth label="Authentication code" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} slotProps={{ htmlInput: { 'aria-label': 'Authentication code' } }} />}
      </DialogContent>
      <DialogActions><Button onClick={onCancel}>Cancel</Button><Button variant="contained" onClick={submit}>Verify</Button></DialogActions>
    </Dialog>
  );
}
