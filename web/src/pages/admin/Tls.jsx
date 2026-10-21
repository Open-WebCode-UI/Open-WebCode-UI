import { useEffect, useState } from 'react';
import { Alert, Box, Button, FormControl, FormControlLabel, Paper, Radio, RadioGroup, Stack, Typography } from '@mui/material';
import { get, put, post } from '../../api.js';
import { useAuth } from '../../AuthContext.jsx';
import { useStepUp } from '../../components/StepUp.jsx';
import { errText } from './common.jsx';

const MANAGED = {
  environment: 'HTTPS is set by the server environment (TLS_CERT and TLS_KEY, or an https://localhost address). Change it there.',
  proxy: 'A reverse proxy in front of this server handles HTTPS (TRUST_PROXY is set). Manage the certificate on the proxy.',
};
const when = (iso) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

function Certificate({ title, cert }) {
  const rows = [['Issued to', cert.subject], ['Issued by', cert.issuer + (cert.selfSigned ? ' (self-signed)' : '')], ['Valid for', cert.altNames.join(', ').replace(/DNS:|IP Address:/g, '')],
    ['Valid from', when(cert.validFrom)], ['Expires', when(cert.validTo)], ['Fingerprint (SHA-256)', cert.fingerprint]];
  return (
    <Paper variant="outlined" sx={{ p: 2 }} component="section" aria-label={title}>
      <Typography variant="subtitle1" gutterBottom>{title}</Typography>
      <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'max-content minmax(0,1fr)', columnGap: 2, rowGap: 0.5 }}>
        {rows.map(([k, v]) => (<Box key={k} sx={{ display: 'contents' }}><Typography component="dt" variant="body2" color="text.secondary">{k}</Typography><Typography component="dd" variant="body2" sx={{ m: 0, wordBreak: 'break-all' }}>{v}</Typography></Box>))}
      </Box>
    </Paper>
  );
}

// Lets an administrator pick how the server is served when nothing else (environment, reverse proxy) decides, and shows the certificate.
export default function Tls() {
  const { can } = useAuth(); const writable = can('settings.write');
  const { run, dialog } = useStepUp();
  const [st, setSt] = useState(null); const [choice, setChoice] = useState(''); const [msg, setMsg] = useState(null); const [saveMsg, setSaveMsg] = useState(null);
  useEffect(() => { get('/api/admin/tls').then((d) => { setSt(d); setChoice(d.mode && d.mode !== 'unset' ? d.mode : ''); }).catch((e) => setMsg({ s: 'error', t: errText(e) })); }, []);
  const act = async (fn, done) => {
    setSaveMsg(null);
    try { const d = await run(fn); setSt(d); setSaveMsg({ s: 'success', t: done }); } catch (e) { if (e.message !== 'canceled') setSaveMsg({ s: 'warning', t: `Not saved: ${errText(e)}` }); }
  };
  if (!st) return msg ? <Alert severity="error">{msg.t}</Alert> : null;
  const admin = st.managedBy === 'admin';

  return (
    <Box>
      <Typography variant="h5" component="h1" gutterBottom>HTTPS</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Whether people connect to this server over an encrypted (HTTPS) connection, and the certificate it uses.</Typography>
      {msg && <Alert severity={msg.s} sx={{ mb: 2 }} onClose={() => setMsg(null)}>{msg.t}</Alert>}
      <Stack spacing={2}>
        {st.needsChoice && <Alert severity="warning">HTTPS is not set up yet, so everything, including passwords, travels unencrypted. Choose an option below.</Alert>}
        {st.restartRequired && <Alert severity="info">Saved. Restart the server to apply it{choice === 'self-signed' ? `; afterwards open the site with https:// and accept your browser's warning about the certificate` : ''}.</Alert>}
        {!admin && <Alert severity="info">{MANAGED[st.managedBy]}</Alert>}
        {admin && (
          <Paper variant="outlined" sx={{ p: 2 }} component="section" aria-label="HTTPS mode">
            <FormControl component="fieldset" disabled={!writable}>
              <Typography variant="subtitle1" component="legend">Connection security</Typography>
              <RadioGroup value={choice} onChange={(e) => setChoice(e.target.value)}>
                <FormControlLabel value="self-signed" control={<Radio />} label={<Box><Typography>Self-signed certificate</Typography><Typography variant="caption" color="text.secondary">Encrypts traffic with a certificate this server creates for {st.hostname}. Browsers show a warning until each person trusts it. Fine for testing or a private network.</Typography></Box>} />
                <FormControlLabel value="none" control={<Radio />} label={<Box><Typography>No HTTPS (unencrypted)</Typography><Typography variant="caption" color="text.secondary">Passwords and code are sent in the clear. Only use this on a trusted network, or when something else encrypts the connection.</Typography></Box>} />
              </RadioGroup>
            </FormControl>
            {writable && saveMsg && <Alert severity={saveMsg.s} sx={{ mt: 2 }} onClose={() => setSaveMsg(null)}>{saveMsg.t}</Alert>}
            {writable && (
              <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                <Button variant="contained" disabled={!choice || choice === st.mode} onClick={() => act(() => put('/api/admin/tls', { mode: choice }), 'Settings saved.')}>Save</Button>
                {st.mode === 'self-signed' && <Button variant="outlined" onClick={() => act(() => post('/api/admin/tls/regenerate', {}), 'New certificate created')}>Create a new certificate</Button>}
              </Stack>)}
          </Paper>)}
        <Typography variant="body2">Right now the server is using <strong>{st.running.https ? 'HTTPS' : 'plain HTTP'}</strong>{st.running.source ? ` with a ${st.running.source === 'configured' ? 'supplied' : 'self-signed'} certificate` : ''}.</Typography>
        {st.certificate && <Certificate title="Current certificate" cert={st.certificate} />}
        {st.pendingCertificate && <Certificate title="Certificate after restart" cert={st.pendingCertificate} />}
      </Stack>
      {dialog}
    </Box>
  );
}
