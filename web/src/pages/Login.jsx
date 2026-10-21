import { useState } from 'react';
import { Box, Paper, Typography, Button, TextField, Alert, Divider, Link, Stack } from '@mui/material';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { hasTerms } from '../components/ContactFooter.jsx';
import { post, ApiError } from '../api.js';
import { useAuth } from '../AuthContext.jsx';

export function HelpdeskInfo({ g }) {
  const lines = [g.helpdeskEmail && `Email: ${g.helpdeskEmail}`, g.helpdeskPhone && `Phone: ${g.helpdeskPhone}`, g.helpdeskHours && `Hours: ${g.helpdeskHours}`].filter(Boolean);
  if (!lines.length && !g.supportMessage && !g.helpdeskUrl) return null;
  return (
    <Box sx={{ mt: 3 }}>
      <Typography variant="subtitle2">Need help?</Typography>
      {g.supportMessage && <Typography variant="body2">{g.supportMessage}</Typography>}
      {lines.map((l) => <Typography key={l} variant="body2">{l}</Typography>)}
      {g.helpdeskUrl && <Link href={g.helpdeskUrl} target="_blank" rel="noopener noreferrer" variant="body2">Helpdesk portal</Link>}
    </Box>
  );
}

// Regular username/password sign-in first; an SSO button is added below it when SAML is configured. (/login/local is kept as an alias.)
export default function Login() {
  const { config, refresh, expired } = useAuth();
  const g = config?.general || {};
  const loc = useLocation();
  const [form, setForm] = useState({ username: '', password: '' });
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault(); setErr('');
    try { await post('/api/auth/local/login', form); await refresh(); } catch (x) { setErr(x instanceof ApiError && x.status === 429 ? 'Too many attempts. Try again later.' : 'Invalid credentials'); }
  };
  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
      <Paper sx={{ p: 4, maxWidth: 440, width: '100%' }}>
        {config?.branding?.logoDataUrl && <Box component="img" src={config.branding.logoDataUrl} alt="" sx={{ maxHeight: 56, mb: 2 }} />}
        <Typography variant="h5" gutterBottom>{g.appName}</Typography>
        {g.tagline && <Typography color="text.secondary" gutterBottom>{g.tagline}</Typography>}
        {config?.branding?.loginText && <Typography variant="body2" sx={{ my: 1 }}>{config.branding.loginText}</Typography>}
        {g.loginBanner && <Alert severity="info" sx={{ my: 2 }}>{g.loginBanner}</Alert>}
        {new URLSearchParams(loc.search).get('error') && <Alert severity="error" sx={{ my: 2 }}>Sign-in failed.</Alert>}
        {expired && !err && <Alert severity="warning" sx={{ my: 2 }}>Your session has expired. Please sign in again.</Alert>}
        {err && <Alert severity="error" sx={{ my: 2 }}>{err}</Alert>}
        {config?.localLoginEnabled && (
          <Box component="form" onSubmit={submit} sx={{ mt: 2 }}>
            <Stack spacing={2}>
              <TextField label="Username" autoComplete="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required />
              <TextField label="Password" type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
              <Button type="submit" variant="contained" size="large">Sign in</Button>
            </Stack>
          </Box>
        )}
        {config?.samlEnabled && (
          <>
            {config?.localLoginEnabled && <Divider sx={{ my: 2 }}>or</Divider>}
            <Button fullWidth variant={config?.localLoginEnabled ? 'outlined' : 'contained'} size="large" href="/auth/saml/login" sx={{ mt: config?.localLoginEnabled ? 0 : 2 }}>{config.ssoButtonText || 'Log in with SSO'}</Button>
          </>
        )}
        {!config?.localLoginEnabled && !config?.samlEnabled && <Alert severity="warning" sx={{ mt: 2 }}>No sign-in method is enabled. Contact your administrator.</Alert>}
        {hasTerms(g) && <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 2 }}>By signing in you agree to the <Link component={RouterLink} to="/terms">terms and acceptable use</Link>.</Typography>}
        <HelpdeskInfo g={g} />
      </Paper>
    </Box>
  );
}
