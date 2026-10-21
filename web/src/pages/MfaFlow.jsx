import { useState } from 'react';
import { Box, Paper, Typography, Button, TextField, Alert, Stack, List, ListItem } from '@mui/material';
import { post, setCsrf, ApiError } from '../api.js';
import { useAuth } from '../AuthContext.jsx';

// Shown for partially authenticated sessions: stage 'mfa' (enter code) or 'enroll' (forced enrollment).
export default function MfaFlow() {
  const { stage, refresh, logout } = useAuth();
  const [code, setCode] = useState(''); const [err, setErr] = useState('');
  const [setup, setSetup] = useState(null); const [codes, setCodes] = useState(null);

  const verify = async () => {
    setErr('');
    try { const r = await post('/api/auth/mfa/verify', { code }); setCsrf(r.csrf); await refresh(); } catch (e) { setErr(e instanceof ApiError && e.status === 429 ? 'Too many attempts; sign in again.' : 'Invalid code'); }
  };
  const begin = async () => { try { setSetup(await post('/api/auth/mfa/totp/setup')); } catch { setErr('Could not start enrollment'); } };
  const confirm = async () => {
    setErr('');
    try { const r = await post('/api/auth/mfa/totp/confirm', { code }); setCsrf(r.csrf); setCodes(r.recoveryCodes); } catch { setErr('Invalid code'); }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
      <Paper sx={{ p: 4, maxWidth: 480, width: '100%' }}>
        {codes ? (
          <>
            <Typography variant="h6">Save your recovery codes</Typography>
            <Alert severity="warning" sx={{ my: 2 }}>Each code works once. They will not be shown again.</Alert>
            <List dense sx={{ fontFamily: 'monospace' }}>{codes.map((c) => <ListItem key={c}>{c}</ListItem>)}</List>
            <Button variant="contained" onClick={refresh}>I have saved them</Button>
          </>
        ) : stage === 'enroll' ? (
          <>
            <Typography variant="h6">Set up multi-factor authentication</Typography>
            <Typography variant="body2" sx={{ my: 2 }}>MFA is required for local accounts. Scan the QR code with an authenticator app, then enter the 6-digit code.</Typography>
            {err && <Alert severity="error" sx={{ mb: 2 }}>{err}</Alert>}
            {!setup ? <Button variant="contained" onClick={begin}>Begin</Button> : (
              <Stack spacing={2} alignItems="center">
                <img src={setup.qr} alt="TOTP QR code" width={200} height={200} />
                <Typography variant="caption" sx={{ wordBreak: 'break-all' }}>Manual key: {setup.secret}</Typography>
                <TextField fullWidth label="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} slotProps={{ htmlInput: { inputMode: 'numeric', maxLength: 6 } }} />
                <Button fullWidth variant="contained" onClick={confirm}>Confirm</Button>
              </Stack>
            )}
          </>
        ) : (
          <>
            <Typography variant="h6">Two-step verification</Typography>
            <Typography variant="body2" sx={{ my: 2 }}>Enter the code from your authenticator app, or a recovery code.</Typography>
            {err && <Alert severity="error" sx={{ mb: 2 }}>{err}</Alert>}
            <TextField fullWidth autoFocus label="Code" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && verify()} />
            <Button fullWidth variant="contained" sx={{ mt: 2 }} onClick={verify}>Verify</Button>
          </>
        )}
        <Button sx={{ mt: 2 }} onClick={logout}>Cancel and sign out</Button>
      </Paper>
    </Box>
  );
}
