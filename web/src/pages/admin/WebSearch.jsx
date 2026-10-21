import { useEffect, useState } from 'react';
import { Alert, Box, Button, Stack, Typography, Paper } from '@mui/material';
import { get, put, post } from '../../api.js';
import { useAuth } from '../../AuthContext.jsx';
import { useStepUp } from '../../components/StepUp.jsx';
import { Bool, Pick, Text, errText } from './common.jsx';

const PROVIDERS = [['', 'None (web search unavailable)'], ['brave', 'Brave Search API'], ['searxng', 'SearXNG (self-hosted)']];

// Tenant switch plus the search service the model's web_search tool uses. The API key is write-only.
export default function WebSearch() {
  const { can } = useAuth(); const writable = can('settings.write');
  const { run, dialog } = useStepUp();
  const [allowed, setAllowed] = useState(null); const [form, setForm] = useState(null); const [apiKey, setApiKey] = useState('');
  const [msg, setMsg] = useState(null); const [saveMsg, setSaveMsg] = useState(null); const [busy, setBusy] = useState(false);
  useEffect(() => {
    get('/api/admin/general').then((g) => setAllowed(!!g.webSearchAllowed)).catch((e) => setMsg({ s: 'error', t: errText(e) }));
    get('/api/admin/web-search').then(setForm).catch((e) => setMsg({ s: 'error', t: errText(e) }));
  }, []);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const toggle = async (v) => {
    setMsg(null);
    try { await run(() => put('/api/admin/general', { webSearchAllowed: v })); setAllowed(v); } catch (e) { if (e.message !== 'canceled') setMsg({ s: 'error', t: errText(e) }); }
  };
  const save = async () => {
    setSaveMsg(null);
    try {
      const saved = await run(() => put('/api/admin/web-search', { provider: form.provider, url: form.url, allowPrivate: form.allowPrivate, ...(apiKey ? { apiKey } : {}) }));
      setForm(saved); setApiKey(''); setSaveMsg({ s: 'success', t: 'Settings saved.' });
    } catch (e) { if (e.message !== 'canceled') setSaveMsg({ s: 'warning', t: `Settings were not saved: ${errText(e)}` }); }
  };
  const test = async () => {
    setMsg(null); setBusy(true);
    try { const r = await post('/api/admin/web-search/test', {}); setMsg({ s: r.ok ? 'success' : 'error', t: r.ok ? r.message : `Test failed: ${r.message}` }); } catch (e) { setMsg({ s: 'error', t: errText(e) }); } finally { setBusy(false); }
  };
  if (!form || allowed === null) return msg ? <Alert severity="error">{msg.t}</Alert> : null;

  return (
    <Box>
      <Typography variant="h5" component="h1" gutterBottom>Web search</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Lets the model search the web through a search service you choose. Users can switch it off in their profile and decide per chat whether to use it. The model's search queries are sent to the service.</Typography>
      {msg && <Alert severity={msg.s} sx={{ mb: 2 }} onClose={() => setMsg(null)}>{msg.t}</Alert>}
      <Stack spacing={2}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Bool label="Allow web search for this organization" value={allowed} onChange={writable ? toggle : () => {}} />
          <Typography variant="caption" color="text.secondary" display="block">Off by default. Turning it off here disables it for everyone, whatever their own settings.</Typography>
        </Paper>
        <Paper variant="outlined" sx={{ p: 2 }} component="section" aria-label="Search service">
          <Stack spacing={2}>
            <Typography variant="subtitle1">Search service</Typography>
            <Pick label="Service" value={form.provider} onChange={set('provider')} options={PROVIDERS} />
            {form.provider === 'brave' && (
              <Text label="API key" type="password" autoComplete="off" value={apiKey} onChange={setApiKey}
                placeholder={form.apiKeySet ? '•••••••• (saved; type to replace)' : ''} helperText="From your Brave Search API subscription. Stored encrypted and never shown again." />)}
            {form.provider === 'searxng' && (<>
              <Text label="SearXNG address" value={form.url} onChange={set('url')} placeholder="https://searx.example.com" helperText="The instance must allow JSON output (search.formats includes json)." />
              <Bool label="Allow a private or local address (for an instance inside your network)" value={form.allowPrivate} onChange={set('allowPrivate')} />
            </>)}
            {writable && saveMsg && <Alert severity={saveMsg.s} onClose={() => setSaveMsg(null)}>{saveMsg.t}</Alert>}
            <Stack direction="row" spacing={1}>
              {writable && <Button variant="contained" onClick={save}>Save</Button>}
              {writable && <Button variant="outlined" disabled={busy || !form.provider} onClick={test}>Test saved settings</Button>}
            </Stack>
          </Stack>
        </Paper>
      </Stack>
      {dialog}
    </Box>
  );
}
