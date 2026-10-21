import { useCallback, useEffect, useState } from 'react';
import { Alert, Autocomplete, Box, Button, Checkbox, Chip, FormControl, FormControlLabel, IconButton, InputLabel, MenuItem, Select, Stack, Switch, Tab, Tabs, TextField, Typography } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { Link as RouterLink } from 'react-router-dom';
import { api, get, post, put } from '../../api.js';
import { useStepUp } from '../../components/StepUp.jsx';
import UserPicker from '../../components/UserPicker.jsx';
import { errText } from './common.jsx';

function Instructors() {
  const { run, dialog } = useStepUp();
  const [list, setList] = useState([]); const [pick, setPick] = useState(null); const [msg, setMsg] = useState(null);
  const load = useCallback(() => get('/api/admin/instructors').then(setList), []);
  useEffect(() => { load(); }, [load]);
  const set = async (id, instructor) => {
    try { await run(() => put(`/api/admin/instructors/${id}`, { instructor })); setPick(null); setMsg(null); load(); } catch (e) { if (e.message !== 'canceled') setMsg(errText(e)); }
  };
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">Instructors can create and run their own courses. Designate someone here, or map a SAML group to the <b>instructor</b> role under Users &amp; roles.</Typography>
      {msg && <Alert severity="error" onClose={() => setMsg(null)}>{msg}</Alert>}
      <Stack direction="row" spacing={1}>
        <UserPicker label="Designate an instructor" value={pick} onPick={setPick} sx={{ flexGrow: 1, maxWidth: 420 }} />
        <Button variant="contained" disabled={!pick} onClick={() => set(pick.id, true)}>Designate</Button>
      </Stack>
      {!list.length && <Typography color="text.secondary">No instructors yet.</Typography>}
      {list.map((i) => (
        <Stack key={i.id} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography sx={{ flexGrow: 1 }}>{i.label} <Typography component="span" variant="caption" color="text.secondary">{i.username}</Typography></Typography>
          {i.viaSaml && <Chip size="small" label="Via SSO group" />}
          {i.manual && <Button size="small" color="error" onClick={() => set(i.id, false)}>Remove</Button>}
        </Stack>
      ))}
      {dialog}
    </Stack>
  );
}

function AllCourses() {
  const [courses, setCourses] = useState([]); const [groups, setGroups] = useState([]); const [msg, setMsg] = useState(null);
  const load = useCallback(() => get('/api/admin/courses').then(setCourses), []);
  useEffect(() => { load(); get('/api/admin/course-groups').then(setGroups).catch(() => {}); }, [load]);
  const change = async (fn) => { try { await fn(); setMsg(null); load(); } catch (e) { setMsg(errText(e)); } };
  return (
    <Stack spacing={3}>
      <Typography variant="body2" color="text.secondary">Assign a course to a SAML group and everyone in that group can take it once it is published. Group membership updates when people sign in.</Typography>
      {msg && <Alert severity="error" onClose={() => setMsg(null)}>{msg}</Alert>}
      {!courses.length && <Typography color="text.secondary">No courses have been created yet.</Typography>}
      {courses.map((c) => (
        <Box key={c.id} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
            <Typography variant="h6" component="h3" sx={{ flexGrow: 1 }}>{c.title}</Typography>
            <Chip size="small" label={c.status} />
            <Button size="small" component={RouterLink} to={`/courses/${c.id}/edit`}>Open</Button>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>Owner: {c.owner}</Typography>
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
            {c.groups.map((g) => <Chip key={g} label={g} onDelete={() => change(() => api('DELETE', `/api/courses/${c.id}/enrollments`, { type: 'saml_group', id: g }))} />)}
          </Stack>
          <Autocomplete freeSolo size="small" options={groups.filter((g) => !c.groups.includes(g))} value="" sx={{ maxWidth: 360 }}
            onChange={(_, v) => { if (v?.trim()) change(() => post(`/api/courses/${c.id}/enrollments`, { type: 'saml_group', id: v.trim() })); }}
            renderInput={(p) => <TextField {...p} label="Add SAML group" helperText="Pick a known group or type a name, then press Enter" />} />
        </Box>
      ))}
    </Stack>
  );
}

const TYPES = { notes: 'Learner notes', hints: 'Hints', resources: 'Resource links', progress: 'Course progress' };
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);

// The catalog of panels a tutor page can show. Instructors choose from the enabled ones for each page.
function TutorPanels() {
  const [rows, setRows] = useState(null); const [msg, setMsg] = useState(null); const [label, setLabel] = useState(''); const [type, setType] = useState('notes');
  useEffect(() => { get('/api/admin/course-settings').then((r) => setRows(r.subpanels)); }, []);
  if (!rows) return null;
  const patch = (id, v) => setRows(rows.map((r) => (r.id === id ? { ...r, ...v } : r)));
  const add = () => {
    let id = slug(label) || type; while (rows.some((r) => r.id === id)) id = `${id.slice(0, 29)}-2`;
    setRows([...rows, { id, label: label.trim(), type, enabled: true }]); setLabel('');
  };
  const save = async () => { try { setRows((await put('/api/admin/course-settings', { subpanels: rows })).subpanels); setMsg({ s: 'success', t: 'Saved' }); } catch (e) { setMsg({ s: 'error', t: errText(e) }); } };
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">These are the panels an instructor can show beside the tutor on a page. Turning one off hides it from new pages and from learners.</Typography>
      {msg && <Alert severity={msg.s} onClose={() => setMsg(null)}>{msg.t}</Alert>}
      {rows.map((r) => (
        <Stack key={r.id} direction="row" spacing={2} sx={{ alignItems: 'center' }}>
          <Switch checked={r.enabled} onChange={(e) => patch(r.id, { enabled: e.target.checked })} slotProps={{ input: { 'aria-label': `Enable ${r.label}` } }} />
          <TextField size="small" label="Name" value={r.label} onChange={(e) => patch(r.id, { label: e.target.value })} />
          <Chip size="small" label={TYPES[r.type]} />
          <IconButton aria-label={`Remove ${r.label}`} onClick={() => setRows(rows.filter((x) => x.id !== r.id))}><DeleteIcon /></IconButton>
        </Stack>
      ))}
      <Stack direction="row" spacing={1}>
        <TextField size="small" label="New panel name" value={label} onChange={(e) => setLabel(e.target.value)} />
        <FormControl size="small" sx={{ minWidth: 180 }}><InputLabel id="sp-type">Kind</InputLabel>
          <Select labelId="sp-type" label="Kind" value={type} onChange={(e) => setType(e.target.value)}>{Object.entries(TYPES).map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}</Select></FormControl>
        <Button disabled={!label.trim() || rows.length >= 20} onClick={add}>Add panel</Button>
      </Stack>
      <Box><Button variant="contained" disabled={rows.some((r) => !r.label.trim())} onClick={save}>Save panels</Button></Box>
    </Stack>
  );
}

// Which models an instructor can choose for a course page or exercise. Unrestricted by default.
function CourseModels() {
  const [providers, setProviders] = useState(null); const [allowed, setAllowed] = useState(undefined); const [msg, setMsg] = useState(null);
  useEffect(() => { get('/api/admin/providers').then(setProviders).catch((e) => setMsg({ s: 'error', t: errText(e) })); get('/api/admin/course-settings').then((r) => setAllowed(r.allowedModelIds ?? null)); }, []);
  if (!providers || allowed === undefined) return msg ? <Alert severity={msg.s}>{msg.t}</Alert> : null;
  const restricted = allowed !== null; const all = providers.flatMap((p) => p.models.filter((m) => m.enabled).map((m) => m.id));
  const toggle = (id) => setAllowed(allowed.includes(id) ? allowed.filter((x) => x !== id) : [...allowed, id]);
  const save = async () => { try { const r = await put('/api/admin/course-settings', { allowedModelIds: allowed }); setAllowed(r.allowedModelIds ?? null); setMsg({ s: 'success', t: 'Saved' }); } catch (e) { setMsg({ s: 'error', t: errText(e) }); } };
  return (
    <Stack spacing={1}>
      <Typography variant="body2" color="text.secondary">Limit the models an instructor can choose for a tutor or chat page, or for an exercise. Pages already using a model that is no longer allowed fall back to the platform default. Learners’ own model choices are not affected.</Typography>
      {msg && <Alert severity={msg.s} onClose={() => setMsg(null)}>{msg.t}</Alert>}
      <FormControlLabel control={<Switch checked={restricted} onChange={(e) => setAllowed(e.target.checked ? all : null)} />} label="Restrict the models instructors can choose" />
      {restricted && providers.map((p) => {
        const ms = p.models.filter((m) => m.enabled);
        return ms.length > 0 && (
          <Box key={p.id}>
            <Typography variant="subtitle2">{p.name}</Typography>
            {ms.map((m) => <FormControlLabel key={m.id} sx={{ display: 'block' }} label={m.label || m.modelId} control={<Checkbox checked={allowed.includes(m.id)} onChange={() => toggle(m.id)} />} />)}
          </Box>
        );
      })}
      {restricted && !allowed.length && <Alert severity="info">No models are allowed, so instructors can only use the platform default.</Alert>}
      <Box><Button variant="contained" onClick={save}>Save models</Button></Box>
    </Stack>
  );
}

export default function Courses() {
  const [tab, setTab] = useState('instructors');
  return (
    <Box>
      <Typography variant="h5" component="h1" gutterBottom>Courses</Typography>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}><Tab value="instructors" label="Instructors" /><Tab value="courses" label="Courses &amp; groups" /><Tab value="panels" label="Tutor panels" /><Tab value="models" label="Models" /></Tabs>
      {tab === 'instructors' ? <Instructors /> : tab === 'courses' ? <AllCourses /> : tab === 'models' ? <CourseModels /> : <TutorPanels />}
    </Box>
  );
}
