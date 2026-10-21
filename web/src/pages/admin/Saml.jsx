import { useEffect, useState, useCallback } from 'react';
import { Box, Typography, Tabs, Tab, Stack, Button, Alert, TextField, Paper, Chip, ToggleButton, ToggleButtonGroup } from '@mui/material';
import { get, post, put } from '../../api.js';
import { useAuth } from '../../AuthContext.jsx';
import { useStepUp } from '../../components/StepUp.jsx';
import { Text, Num, Bool, Pick, Lines, errText } from './common.jsx';

const NAMEID_OPTIONS = (ids) => [[ids.persistent, 'Persistent (recommended)'], [ids.unspecified, 'Unspecified'], [ids.emailAddress, 'Email address'], [ids.transient, 'Transient']];

export default function Saml() {
  const { can } = useAuth(); const write = can('idp.write'); const canMap = can('role.write');
  const { run, dialog } = useStepUp();
  const [tab, setTab] = useState('idp'); const [data, setData] = useState(null); const [s, setS] = useState(null); const [msg, setMsg] = useState(null); const [saveMsg, setSaveMsg] = useState(null);
  const [map, setMap] = useState([]); const [spXml, setSpXml] = useState(''); const [src, setSrc] = useState('url'); const [url, setUrl] = useState(''); const [xml, setXml] = useState(''); const [preview, setPreview] = useState(null); const [sec, setSec] = useState(null);
  const load = useCallback(() => get('/api/admin/saml').then((d) => { setData(d); setS(d.settings); setMap(d.groupMap); setUrl(d.settings.metadataUrl || ''); }).catch((e) => setMsg({ s: 'error', t: errText(e) })), []);
  useEffect(() => { load(); }, [load]);
  if (!s) return msg ? <Alert severity="error">{msg.t}</Alert> : null;
  const set = (k) => (v) => setS((x) => ({ ...x, [k]: v }));

  const save = async (extra = {}) => { setSaveMsg(null); try { const r = await run(() => put('/api/admin/saml', { ...s, ...extra })); setS(r); setSaveMsg({ s: 'success', t: 'Settings saved.' }); load(); } catch (e) { if (e.message !== 'canceled') setSaveMsg({ s: 'warning', t: `Settings were not saved: ${errText(e)}` }); } };
  const saveMap = async () => { setSaveMsg(null); try { await run(() => put('/api/admin/group-map', { mappings: map.filter((m) => m.groupValue.trim()) })); setSaveMsg({ s: 'success', t: 'Mappings saved.' }); load(); } catch (e) { if (e.message !== 'canceled') setSaveMsg({ s: 'warning', t: `Mappings were not saved: ${errText(e)}` }); } };
  const autoPopulate = async () => {
    setMsg(null);
    try { setPreview(await post('/api/admin/saml/metadata/preview', src === 'url' ? { url } : { xml })); } catch (e) { setMsg({ s: 'error', t: `Could not read metadata: ${errText(e)}` }); }
  };
  const apply = () => {
    setS((x) => ({ ...x, metadataSource: src, metadataUrl: src === 'url' ? url : '', idpEntityId: preview.idpEntityId, ssoUrl: preview.ssoUrl, sloUrl: preview.sloUrl, idpCerts: preview.idpCerts, nameIdFormat: preview.suggestedNameIdFormat }));
    setPreview(null); setMsg({ s: 'info', t: 'Fields populated from metadata. Review them, then press Save.' });
  };
  const onFile = (e) => { const f = e.target.files[0]; if (f) f.text().then(setXml); };
  const ids = data.nameIdFormats;

  return (
    <Box>
      <Typography variant="h5" gutterBottom>SAML single sign-on</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>This application is a SAML service provider. Configure your identity provider (IdP) here, and give the IdP the service-provider metadata from the SP tab.</Typography>
      {msg && <Alert severity={msg.s} sx={{ mb: 2 }} onClose={() => setMsg(null)}>{msg.t}</Alert>}
      <Bool label="Enable SAML sign-in" value={s.enabled} onChange={set('enabled')} />
      <Box sx={{ mb: 1 }}><Text label="Login button text" value={s.buttonText} onChange={set('buttonText')} helperText="Shown on the login page beneath the regular sign-in form, only while SAML sign-in is enabled and configured." /></Box>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }} variant="scrollable">
        <Tab value="idp" label="Identity provider" /><Tab value="sp" label="Service provider" /><Tab value="attrs" label="Attributes & NameID" /><Tab value="groups" label="Group mapping" /><Tab value="test" label="Test" />
      </Tabs>

      {tab === 'idp' && <Stack spacing={2}>
        <Alert severity="info">Get this information from your organization's IdP.</Alert>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle2" gutterBottom>IdP metadata</Typography>
          <ToggleButtonGroup size="small" exclusive value={src} onChange={(_, v) => v && setSrc(v)} sx={{ mb: 1 }}><ToggleButton value="url">Metadata URL</ToggleButton><ToggleButton value="file">Upload file</ToggleButton></ToggleButtonGroup>
          {src === 'url' ? <TextField fullWidth size="small" label="Metadata URL (https)" value={url} onChange={(e) => setUrl(e.target.value)} />
            : <Stack direction="row" spacing={1} alignItems="center"><Button component="label" size="small" variant="outlined">Choose XML file<input hidden type="file" accept=".xml,text/xml,application/xml" onChange={onFile} /></Button><Typography variant="caption">{xml ? `${xml.length} bytes loaded` : 'No file chosen'}</Typography></Stack>}
          {write && <Button sx={{ mt: 1 }} variant="contained" disabled={src === 'url' ? !url : !xml} onClick={autoPopulate}>Auto-populate IdP metadata</Button>}
          {preview && (
            <Alert severity="success" sx={{ mt: 2 }} action={<Button color="inherit" size="small" onClick={apply}>Use these</Button>}>
              <b>{preview.idpEntityId}</b><br />SSO: {preview.ssoUrl}<br />{preview.idpCerts.length} signing certificate(s) · NameID formats: {preview.nameIdFormats.map((f) => f.split(':').pop()).join(', ') || 'none advertised'}
              {!preview.persistentAvailable && <><br /><b>Note:</b> this IdP does not advertise the persistent NameID format.</>}
            </Alert>)}
        </Paper>
        <Text label="IdP entity ID" value={s.idpEntityId} onChange={set('idpEntityId')} />
        <Text label="SSO URL" value={s.ssoUrl} onChange={set('ssoUrl')} />
        <Text label="Single logout URL (optional)" value={s.sloUrl} onChange={set('sloUrl')} />
        <Lines label="IdP signing certificates (PEM; separate multiple with a blank line is not needed — one per field below)" value={s.idpCerts} onChange={(v) => set('idpCerts')(v)} helperText="Populated automatically from metadata. Paste PEM blocks only if entering manually." sx={{ display: 'none' }} />
        <TextField fullWidth size="small" multiline minRows={4} label="IdP signing certificate(s) (PEM)" value={(s.idpCerts || []).join('\n')} onChange={(e) => set('idpCerts')(e.target.value.split(/(?=-----BEGIN CERTIFICATE-----)/).map((c) => c.trim()).filter(Boolean))} />
        <Bool label="Require signed assertions" value={s.wantAssertionsSigned} onChange={set('wantAssertionsSigned')} />
        <Bool label="Require signed response" value={s.wantResponseSigned} onChange={set('wantResponseSigned')} />
        <Bool label="Allow private-network metadata hosts (not recommended)" value={s.allowPrivateMetadataHosts} onChange={set('allowPrivateMetadataHosts')} />
      </Stack>}

      {tab === 'sp' && <Stack spacing={2}>
        <Alert severity="info">Provide this information to your organization's IdP.</Alert>
        <Text label="SP entity ID (blank = use metadata URL)" value={s.spEntityId} onChange={set('spEntityId')} helperText={`Effective: ${data.spEntityIdEffective}`} />
        <TextField fullWidth size="small" label="Assertion Consumer Service (ACS) URL" value={data.acsUrl} slotProps={{ input: { readOnly: true } }} helperText="Derived from the server's BASE_URL." />
        <TextField fullWidth size="small" label="SP metadata URL" value={data.spMetadataUrl} slotProps={{ input: { readOnly: true } }} />
        <Bool label="Sign authentication requests" value={s.signAuthnRequests} onChange={set('signAuthnRequests')} />
        <Stack direction="row" spacing={1}>
          {write && <Button variant="outlined" onClick={async () => { try { await run(() => post('/api/admin/saml/sp-cert')); setMsg({ s: 'success', t: 'SP certificate generated' }); load(); } catch (e) { if (e.message !== 'canceled') setMsg({ s: 'error', t: errText(e) }); } }}>{s.spCert ? 'Regenerate SP certificate' : 'Generate SP certificate'}</Button>}
          <Button variant="outlined" onClick={async () => { const r = await fetch('/api/admin/saml/sp-metadata', { credentials: 'same-origin' }); const b = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'sp-metadata.xml'; a.click(); }}>Download SP metadata</Button>
          <Button variant="outlined" onClick={async () => { try { const r = await fetch('/api/admin/saml/sp-metadata', { credentials: 'same-origin' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); setSpXml(await r.text()); } catch (e) { setMsg({ s: 'error', t: `Could not load SP metadata: ${e.message}` }); } }}>View SP metadata</Button>
        </Stack>
        {spXml && <Box>
          <TextField fullWidth multiline minRows={6} maxRows={20} size="small" label="SP metadata (XML)" value={spXml} slotProps={{ input: { readOnly: true, sx: { fontFamily: 'monospace', fontSize: 12 } } }} />
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}><Button size="small" onClick={() => navigator.clipboard?.writeText(spXml).then(() => setMsg({ s: 'success', t: 'SP metadata copied' }), () => setMsg({ s: 'error', t: 'Copy failed; select the text and copy it manually.' }))}>Copy</Button><Button size="small" onClick={() => setSpXml('')}>Hide</Button></Stack>
        </Box>}
        {s.spCert && <Chip label="SP certificate present (private key stored encrypted)" color="success" variant="outlined" />}
      </Stack>}

      {tab === 'attrs' && <Stack spacing={2}>
        <Alert severity="info">Compare and match this information using your organization's IdP.</Alert>
        <Pick label="NameID format requested from the IdP" value={s.nameIdFormat} onChange={set('nameIdFormat')} options={NAMEID_OPTIONS(ids)} helperText={s.nameIdFormat} />
        {s.nameIdFormat === ids.persistent
          ? <Alert severity="success">Persistent is a good choice: it is an opaque, stable, per-application identifier that carries no human-readable information (better for privacy). Name and email are taken from attributes instead.</Alert>
          : <Alert severity="warning">{s.nameIdFormat === ids.transient ? 'Transient NameIDs change every login, so you must choose a unique-ID attribute below.' : 'Unspecified/email NameIDs may contain a human-readable value (username or email) and their stability depends on the IdP. Persistent is recommended.'} Your choice is honored.</Alert>}
        <Text label="Unique-ID attribute (optional; blank = use NameID)" value={s.uniqueIdAttribute} onChange={set('uniqueIdAttribute')} />
        <Typography variant="subtitle2">Required attributes</Typography>
        <Text label="Email attribute" value={s.attrEmail} onChange={set('attrEmail')} /><Text label="First name attribute" value={s.attrFirstName} onChange={set('attrFirstName')} /><Text label="Last name attribute" value={s.attrLastName} onChange={set('attrLastName')} />
        <Text label="Display name attribute (optional)" value={s.attrDisplayName} onChange={set('attrDisplayName')} />
        <Text label="Group membership attribute" value={s.attrGroups} onChange={set('attrGroups')} helperText="e.g. memberOf or groups. 'groups' and common claim URIs are tried as fallbacks." />
        <Num label="Allowed clock skew (seconds)" value={s.clockSkewSec} onChange={set('clockSkewSec')} />
        <Typography variant="body2" color="text.secondary">Map IdP groups to roles on the "Group mapping" tab. MFA enforcement for SSO users is configured under Security.</Typography>
      </Stack>}

      {tab === 'groups' && <Stack spacing={2}>
        <Alert severity="info">Group values come from the group attribute set on the Attributes &amp; NameID tab (memberOf / groups). For Active Directory, you can use either the full DN or just the CN. Roles from SSO are re-synced at every sign-in.</Alert>
        <Typography variant="subtitle2">IdP group → role mapping</Typography>
        {map.map((m, i) => (
          <Stack key={i} direction="row" spacing={1}>
            <TextField size="small" fullWidth label="Group value" value={m.groupValue} disabled={!canMap} onChange={(e) => setMap(map.map((x, j) => (j === i ? { ...x, groupValue: e.target.value } : x)))} />
            <TextField select size="small" sx={{ minWidth: 200 }} label="Role" slotProps={{ select: { native: true } }} value={m.roleId} disabled={!canMap} onChange={(e) => setMap(map.map((x, j) => (j === i ? { ...x, roleId: Number(e.target.value) } : x)))}>{data.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</TextField>
            {canMap && <Button color="error" onClick={() => setMap(map.filter((_, j) => j !== i))}>Remove</Button>}
          </Stack>))}
        {canMap && saveMsg && <Alert severity={saveMsg.s} onClose={() => setSaveMsg(null)}>{saveMsg.t}</Alert>}
        {canMap && <Stack direction="row" spacing={1}><Button onClick={() => setMap([...map, { groupValue: '', roleId: data.roles.find((r) => r.name === 'developer')?.id ?? data.roles[0]?.id }])}>Add mapping</Button>
          <Button variant="contained" onClick={saveMap}>Save mappings</Button></Stack>}
        {!canMap && <Typography variant="caption" color="text.secondary">Changing mappings needs the role.write permission.</Typography>}
        <Pick label="Default role (users with no mapped group)" value={s.defaultRoleId ?? ''} onChange={(v) => set('defaultRoleId')(v === '' ? null : Number(v))}
          options={[['', 'None — refuse sign-in'], ...data.roles.map((r) => [r.id, r.name])]}
          helperText="Given to SSO users whose groups match no mapping, or whose IdP sends no groups. With no default role, those users are refused at sign-in. Choose a least-privilege role. Saved with Save SAML settings." />
      </Stack>}

      {tab === 'test' && <Stack spacing={2}>
        <Alert severity="info">Opens your IdP in a new tab and shows the NameID, attributes, and groups it returns — without creating a session or user. Save your settings first.</Alert>
        <Box><Button variant="outlined" href="/auth/saml/login?test=1" target="_blank" rel="noopener">Run test sign-in</Button></Box>
      </Stack>}

      {write && tab !== 'test' && saveMsg && <Alert severity={saveMsg.s} sx={{ mt: 3 }} onClose={() => setSaveMsg(null)}>{saveMsg.t}</Alert>}
      {write && tab !== 'test' && <Button variant="contained" sx={{ mt: 3 }} onClick={() => save()}>Save SAML settings</Button>}
      {dialog}
    </Box>
  );
}
