import { useEffect, useState } from 'react';
import { Box, Typography, Tabs, Tab, TextField, Button, Stack, Alert, Paper, Chip, Select, MenuItem, ListItemButton, Dialog, DialogTitle, DialogContent, DialogActions, List, ListItem, ListItemText, FormControl, InputLabel, FormControlLabel, FormGroup, Switch, ToggleButton, ToggleButtonGroup } from '@mui/material';
import { useColorMode } from '../colorMode.jsx';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { get, post, put } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import SkillsManager from '../components/SkillsManager.jsx';
import SectionShell from '../components/SectionShell.jsx';
import { useTutorial } from '../tour/TutorialProvider.jsx';
import { UserMcpServers } from '../components/McpServers.jsx';
import MemoryManager from '../components/MemoryManager.jsx';

const KINDS = [['plan', 'Plan mode'], ['act', 'Act mode'], ['chat', 'Coding chat'], ['general', 'General chat'], ['course', 'Course Design chat']];

const SECTIONS = [
  { path: 'account', label: 'Account' },
  { path: 'prompts', label: 'System prompts', anyOf: ['agent.plan', 'chat.use', 'chat.general.use', 'chat.course.use'] },
  { path: 'skills', label: 'Agent skills', perm: 'agent.plan' },
  { path: 'chat-skills', label: 'Chat skills', anyOf: ['chat.use', 'chat.general.use', 'chat.course.use'] },
  { path: 'mcp', label: 'MCP servers', perm: 'mcp.use' },
  { path: 'memory', label: 'Memory', perm: 'memory.use' },
  { path: 'web-search', label: 'Web search', perm: 'websearch.use' },
  { path: 'security', label: 'Security' },
];

// Profile uses the same sidebar-per-section layout as Admin, so no single page grows long.
export default function Profile() {
  const { user, can } = useAuth(); const loc = useLocation();
  if (!user) return null;
  const sections = SECTIONS.filter((s) => (s.perm ? can(s.perm) : s.anyOf ? s.anyOf.some(can) : true));
  const current = sections.find((s) => loc.pathname.replace(/\/+$/, '').endsWith(`/profile/${s.path}`)) || sections[0];
  return (
    <SectionShell contact ariaLabel="Profile" tour="profile-sections" items={sections.map((s) => ({ to: `/profile/${s.path}`, label: s.label, selected: current.path === s.path }))}>
        <Typography variant="h5" component="h1" gutterBottom>{current.label}</Typography>
        {current.path === 'account' && <AccountSection />}
        {current.path === 'prompts' && <PromptsSection />}
        {current.path === 'skills' && <SkillsManager scope="agent" />}
        {current.path === 'chat-skills' && <SkillsManager scope="chat" />}
        {current.path === 'mcp' && <UserMcpServers />}
        {current.path === 'memory' && <MemorySection />}
        {current.path === 'web-search' && <WebSearchSection />}
        {current.path === 'security' && <SecuritySection />}
    </SectionShell>
  );
}

function AccountSection() {
  const { user } = useAuth();
  const tour = useTutorial();
  return (
    <>
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>{user.roles.map((r) => <Chip key={r} size="small" label={r} />)}<Chip size="small" variant="outlined" label={user.source === 'saml' ? 'Single sign-on' : 'Local account'} /></Stack>
    </Paper>
    <NameForm />
    <AppearanceForm />
    {tour && (
      <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
        <Typography variant="subtitle2">Tutorial</Typography>
        <Typography variant="body2" color="text.secondary">{tour.isActive ? `In progress (step ${tour.index + 1} of ${tour.total}).` : tour.isCompleted ? 'You have finished the tour.' : 'A short tour of the app.'}</Typography>
        <Button data-tour="replay-tutorial" sx={{ mt: 1 }} variant="outlined" onClick={tour.start}>Replay tutorial</Button>
      </Paper>
    )}
    </>
  );
}

// The email address is shown for reference only: it identifies the account and is never editable here.
// Single sign-on users get their name from the identity provider, so those fields are read-only too.
function NameForm() {
  const { user, refresh } = useAuth();
  const managed = user.source !== 'local';
  const [f, setF] = useState({ firstName: user.firstName || '', lastName: user.lastName || '' }); const [msg, setMsg] = useState(null);
  const dirty = f.firstName.trim() !== (user.firstName || '') || f.lastName.trim() !== (user.lastName || '');
  const empty = !f.firstName.trim() && !f.lastName.trim();
  const submit = async (e) => {
    e.preventDefault(); setMsg(null);
    try { await put('/api/profile/account', { firstName: f.firstName.trim(), lastName: f.lastName.trim() }); await refresh(); setMsg({ s: 'success', t: 'Name saved.' }); }
    catch (x) { setMsg({ s: 'error', t: x.body?.message || 'Could not save your name.' }); }
  };
  return (
    <Paper component="form" onSubmit={submit} variant="outlined" sx={{ p: 2, mt: 2 }} aria-label="Account details">
      <Typography variant="subtitle1" gutterBottom>Your details</Typography>
      {msg && <Alert severity={msg.s} sx={{ mb: 1 }} onClose={() => setMsg(null)}>{msg.t}</Alert>}
      <Stack spacing={1.5}>
        <TextField label="First name" value={f.firstName} disabled={managed} onChange={(e) => setF({ ...f, firstName: e.target.value })} slotProps={{ htmlInput: { maxLength: 100, autoComplete: 'given-name' } }} />
        <TextField label="Last name" value={f.lastName} disabled={managed} onChange={(e) => setF({ ...f, lastName: e.target.value })} slotProps={{ htmlInput: { maxLength: 100, autoComplete: 'family-name' } }} />
        <TextField label="Email" value={user.email || ''} disabled helperText={managed ? 'Your name and email are managed by your identity provider.' : 'Your email address cannot be changed here.'} slotProps={{ htmlInput: { readOnly: true } }} />
        {!managed && <Box><Button type="submit" variant="contained" disabled={!dirty || empty}>Save name</Button></Box>}
      </Stack>
    </Paper>
  );
}

const SCALES = [[100, 'Default'], [115, 'Large'], [130, 'Larger'], [150, 'Largest']];

// Appearance and accessibility. Saved to the account, so they follow the user to other browsers and devices.
function AppearanceForm() {
  const { user, refresh } = useAuth(); const { choice, setChoice } = useColorMode();
  const p = user.preferences || {}; const [err, setErr] = useState('');
  const save = async (patch) => { setErr(''); try { await put('/api/profile/preferences', patch); await refresh(); } catch { setErr('Could not save that setting.'); } };
  const toggle = (key, label, help) => (
    <FormControlLabel control={<Switch checked={!!p[key]} onChange={(e) => save({ [key]: e.target.checked })} />}
      label={<Box><Typography variant="body2">{label}</Typography><Typography variant="caption" color="text.secondary">{help}</Typography></Box>} />
  );
  return (
    <Paper variant="outlined" sx={{ p: 2, mt: 2 }} component="section" aria-label="Appearance and accessibility">
      <Typography variant="subtitle1" gutterBottom>Appearance and accessibility</Typography>
      {err && <Alert severity="error" sx={{ mb: 1 }} onClose={() => setErr('')}>{err}</Alert>}
      <Stack spacing={2}>
        <Box>
          <Typography variant="body2" id="color-mode-label" gutterBottom>Color mode</Typography>
          <ToggleButtonGroup exclusive size="small" aria-labelledby="color-mode-label" value={choice} onChange={(_, v) => v && setChoice(v)}>
            <ToggleButton value="system">Device default</ToggleButton><ToggleButton value="light">Light</ToggleButton><ToggleButton value="dark">Dark</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        <FormControl size="small" sx={{ maxWidth: 240 }}>
          <InputLabel id="font-scale-label">Text size</InputLabel>
          <Select labelId="font-scale-label" label="Text size" value={p.fontScale || 100} onChange={(e) => save({ fontScale: e.target.value })}>{SCALES.map(([v, l]) => <MenuItem key={v} value={v}>{l} ({v}%)</MenuItem>)}</Select>
        </FormControl>
        <FormGroup>
          {toggle('highContrast', 'High contrast', 'Stronger text and border contrast.')}
          {toggle('reduceMotion', 'Reduce motion', 'Turns off animations and transitions.')}
          {toggle('underlineLinks', 'Always underline links', 'Makes links easier to spot without relying on color.')}
        </FormGroup>
      </Stack>
    </Paper>
  );
}

function PromptsSection() {
  const { can } = useAuth();
  const [data, setData] = useState(null); const [kind, setKind] = useState(null); const [draft, setDraft] = useState({ plan: '', act: '', chat: '', general: '', course: '' }); const [msg, setMsg] = useState('');
  const editable = can('profile.prompt.edit');
  useEffect(() => { get('/api/profile/prompts').then((d) => { setData(d); setDraft({ plan: '', act: '', chat: '', general: '', course: '', ...d.overrides }); setKind(d.kinds[0] || null); }); }, []);
  if (!data || !kind) return null;
  const using = draft[kind].trim() ? 'your custom prompt' : 'the default prompt';
  const save = async () => { await put('/api/profile/prompts', { [kind]: draft[kind] }); setMsg('Saved'); setData({ ...data, overrides: { ...data.overrides, [kind]: draft[kind] } }); };
  return (
    <>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Each mode has a detailed built-in prompt. {editable ? 'Override any of them below; leave empty to use the default.' : 'Your role cannot edit prompts.'}
      </Typography>
      <Tabs value={kind} onChange={(_, v) => { setKind(v); setMsg(''); }}>{KINDS.filter(([k]) => data.kinds.includes(k)).map(([k, l]) => <Tab key={k} value={k} label={l} />)}</Tabs>
      {msg && <Alert severity="success" sx={{ my: 1 }} onClose={() => setMsg('')}>{msg}</Alert>}
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>Currently using {using}.</Typography>
      <TextField fullWidth multiline minRows={12} maxRows={24} disabled={!editable} value={draft[kind] || ''} placeholder={data.defaults[kind]} onChange={(e) => setDraft({ ...draft, [kind]: e.target.value })} slotProps={{ htmlInput: { 'aria-label': `${kind} system prompt` } }} />
      {editable && (
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <Button variant="contained" onClick={save}>Save</Button>
          <Button onClick={() => setDraft({ ...draft, [kind]: data.defaults[kind] })}>Load default to edit</Button>
          <Button color="warning" onClick={async () => { await put('/api/profile/prompts', { [kind]: null }); setDraft({ ...draft, [kind]: '' }); setData({ ...data, overrides: { ...data.overrides, [kind]: '' } }); setMsg('Reset to default'); }}>Reset to default</Button>
        </Stack>
      )}
    </>
  );
}

function SecuritySection() {
  const { user, refresh } = useAuth();
  const [sessions, setSessions] = useState([]); const [mfa, setMfa] = useState(null);
  useEffect(() => { get('/api/auth/sessions').then(setSessions).catch(() => {}); }, []);
  return (
    <>
      <Typography variant="subtitle2" gutterBottom>Multi-factor authentication</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }} data-testid="mfa-status">
        {user.source !== 'local' ? 'Handled by your identity provider.' : user.mfaEnrolled ? `Authenticator app is set up${user.webauthnCount ? `; ${user.webauthnCount} security key${user.webauthnCount === 1 ? '' : 's'} registered` : ''}.` : 'Not set up yet.'}
      </Typography>
      {user.source === 'local' && <PasswordForm />}
      {user.source === 'local' && <Button sx={{ my: 1 }} onClick={() => setMfa(true)}>{user.mfaEnrolled ? 'Re-enroll authenticator app' : 'Set up authenticator app'}</Button>}
      <Typography variant="subtitle2" sx={{ mt: 2 }}>Active sessions</Typography>
      <List dense>{sessions.map((s) => <ListItem key={s.id}><ListItemText primary={`${s.ip || 'unknown'} ${s.current ? '(this session)' : ''}`} secondary={`${s.ua} · last active ${new Date(s.last_seen * 1000).toLocaleString()}`} /></ListItem>)}</List>
      <Button color="warning" onClick={async () => { await post('/api/auth/sessions/revoke-all'); setSessions(await get('/api/auth/sessions')); }}>Sign out all other sessions</Button>
      {mfa && <ReEnrol onClose={() => { setMfa(null); refresh(); }} />}
    </>
  );
}

function ReEnrol({ onClose }) {
  const [s, setS] = useState(null); const [code, setCode] = useState(''); const [codes, setCodes] = useState(null); const [err, setErr] = useState('');
  useEffect(() => { post('/api/auth/mfa/totp/setup').then(setS).catch((e) => setErr(e.body?.error === 'mfa_required' ? 'Please re-verify (use any sensitive admin action to step up) and try again.' : 'Failed')); }, []);
  return (
    <Dialog open onClose={onClose}>
      <DialogTitle>Authenticator app</DialogTitle>
      <DialogContent>
        {err && <Alert severity="error">{err}</Alert>}
        {codes ? <List dense sx={{ fontFamily: 'monospace' }}>{codes.map((c) => <ListItem key={c}>{c}</ListItem>)}</List> : s && (<Stack spacing={1} alignItems="center"><img src={s.qr} alt="TOTP QR code" width={180} /><TextField label="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} /><Button variant="contained" onClick={async () => { try { setCodes((await post('/api/auth/mfa/totp/confirm', { code })).recoveryCodes); } catch { setErr('Invalid code'); } }}>Confirm</Button></Stack>)}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

// Local accounts only (single sign-on users change their password with their identity provider).
function PasswordForm() {
  const [f, setF] = useState({ current: '', next: '', confirm: '' }); const [msg, setMsg] = useState(null);
  const mismatch = f.confirm !== '' && f.confirm !== f.next;
  const submit = async (e) => {
    e.preventDefault(); setMsg(null);
    if (f.next !== f.confirm) return setMsg({ s: 'error', t: 'The new passwords do not match.' });
    try { await post('/api/auth/password', { current: f.current, next: f.next }); setF({ current: '', next: '', confirm: '' }); setMsg({ s: 'success', t: 'Password changed. Your other sessions were signed out.' }); }
    catch (x) { setMsg({ s: 'error', t: x.body?.error === 'invalid_credentials' ? 'Your current password is not correct.' : x.body?.message || x.body?.error || 'Could not change the password.' }); }
  };
  return (
    <Paper component="form" onSubmit={submit} variant="outlined" sx={{ p: 2, mb: 2 }} aria-label="Change password">
      <Typography variant="subtitle1" gutterBottom>Change password</Typography>
      {msg && <Alert severity={msg.s} sx={{ mb: 1 }} onClose={() => setMsg(null)}>{msg.t}</Alert>}
      <Stack spacing={1.5}>
        <TextField type="password" label="Current password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required />
        <TextField type="password" label="New password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required />
        <TextField type="password" label="Confirm new password" autoComplete="new-password" value={f.confirm} error={mismatch} helperText={mismatch ? 'Does not match' : ' '} onChange={(e) => setF({ ...f, confirm: e.target.value })} required />
        <Box><Button type="submit" variant="contained" disabled={!f.current || !f.next || mismatch}>Change password</Button></Box>
      </Stack>
    </Paper>
  );
}

// Profile switch for web search. Each chat still has its own toggle; this one decides whether that toggle can be used at all.
function WebSearchSection() {
  const [st, setSt] = useState(null); const [err, setErr] = useState('');
  useEffect(() => { get('/api/web-search').then(setSt).catch(() => setErr('Could not load web search settings.')); }, []);
  const save = async (enabled) => { setErr(''); try { setSt(await put('/api/web-search/settings', { enabled })); } catch { setErr('Could not save that setting.'); } };
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      {err && <Alert severity="error" sx={{ mb: 1 }} onClose={() => setErr('')}>{err}</Alert>}
      {st && !st.allowed && <Alert severity="info" sx={{ mb: 1 }}>An administrator has turned web search off for your organization.</Alert>}
      {st && st.allowed && !st.configured && <Alert severity="warning" sx={{ mb: 1 }}>No search service is configured yet. Ask an administrator.</Alert>}
      <FormControlLabel disabled={!st} control={<Switch checked={!!st?.enabled} onChange={(e) => save(e.target.checked)} />}
        label={<Box><Typography variant="body2">Let the model search the web</Typography><Typography variant="caption" color="text.secondary">When on, you can switch web search on for individual chats and sessions (it starts off in each one). The model's search queries are sent to the organization's search service, so avoid putting private details in your requests.</Typography></Box>} />
    </Paper>
  );
}

function MemorySection() {
  const [projects, setProjects] = useState([]); const [pid, setPid] = useState('');
  useEffect(() => { get('/api/projects').then(setProjects).catch(() => {}); }, []);
  return (
    <>
      <MemoryManager projectId={pid || undefined} />
      {projects.length > 0 && (
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="body2">Show a project's memory:</Typography>
          <Select size="small" displayEmpty value={pid} onChange={(e) => setPid(e.target.value)} inputProps={{ 'aria-label': 'Project' }}><MenuItem value="">None</MenuItem>{projects.map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}</Select>
        </Stack>)}
    </>
  );
}
