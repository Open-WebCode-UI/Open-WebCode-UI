import { useState } from 'react';
import { Box, Paper, Typography, TextField, Button, Alert, Stack } from '@mui/material';
import { post } from '../api.js';
import { useAuth } from '../AuthContext.jsx';

export default function ChangePassword() {
  const { refresh } = useAuth();
  const [f, setF] = useState({ current: '', next: '' }); const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault(); setErr('');
    try { await post('/api/auth/password', f); await refresh(); } catch (x) { setErr(x.body?.message || x.body?.error || 'Failed'); }
  };
  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
      <Paper component="form" onSubmit={submit} sx={{ p: 4, maxWidth: 440, width: '100%' }}>
        <Typography variant="h6" gutterBottom>Change your password</Typography>
        <Alert severity="info" sx={{ mb: 2 }}>You must set a new password before continuing.</Alert>
        {err && <Alert severity="error" sx={{ mb: 2 }}>{err}</Alert>}
        <Stack spacing={2}>
          <TextField type="password" label="Current password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required />
          <TextField type="password" label="New password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required />
          <Button type="submit" variant="contained">Change password</Button>
        </Stack>
      </Paper>
    </Box>
  );
}
