import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Checkbox, Chip, Divider, FormControl, FormControlLabel, FormGroup, FormHelperText, IconButton, InputLabel, MenuItem, Select, Stack, Switch, Tab, Tabs, TextField, Typography } from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { api, del, get, post, put } from '../../api.js';
import { useAuth } from '../../AuthContext.jsx';
import { PromptDialog } from '../../components/ProjectDialogs.jsx';
import AssessmentEditor from './AssessmentsEditor.jsx';
import UserPicker from '../../components/UserPicker.jsx';
import { RichEditor } from '../../components/RichText.jsx';

const LAYOUTS = [['content', 'Content only'], ['chat', 'Content with chat panel'], ['agent', 'Content with tutor agent panel'], ['agent_file', 'Content with agent and file']];

const toLines = (a = []) => a.join('\n');
const lines = (t) => t.split('\n').map((x) => x.trim()).filter(Boolean);
const linkLines = (links = []) => links.map((l) => `${l.title} | ${l.url}`).join('\n');
const parseLinks = (t) => lines(t).map((l) => { const i = l.lastIndexOf('|'); return i < 0 ? { title: l, url: l } : { title: l.slice(0, i).trim(), url: l.slice(i + 1).trim() }; });

function PageEditor({ courseId, page, modules = [], subpanels = [], onSaved }) {
  const [title, setTitle] = useState(page.title); const [layout, setLayout] = useState(page.layout); const isQuiz = page.layout === 'assessment';
  const [content, setContent] = useState(page.content); const [prompt, setPrompt] = useState(page.config.systemPrompt || '');
  const [msg, setMsg] = useState(''); const [moduleId, setModuleId] = useState(page.moduleId ?? '');
  const [modelId, setModelId] = useState(page.config.modelId ?? ''); const [models, setModels] = useState([]);
  useEffect(() => { Promise.all([get('/api/models'), get('/api/courses-allowed-models').catch(() => ({ allowed: null }))]).then(([r, { allowed }]) => setModels(allowed ? r.models.filter((m) => allowed.includes(m.id)) : r.models)).catch(() => {}); }, []);
  const [thinking, setThinking] = useState(!!page.config.thinking);
  const picked = models.find((m) => m.id === modelId); const cantThink = !!picked && !picked.supportsThinking;
  const [fileName, setFileName] = useState(page.config.fileName || ''); const [fileContent, setFileContent] = useState(page.config.fileContent || '');
  const badFileName = layout === 'agent_file' && fileName !== '' && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(fileName);
  const [on, setOn] = useState(page.config.subpanels || []);
  const [hints, setHints] = useState(toLines(page.config.subpanelContent?.hints?.hints)); const [links, setLinks] = useState(linkLines(page.config.subpanelContent?.resources?.links));
  const typeOf = (id) => subpanels.find((s) => s.id === id)?.type;
  const save = async () => {
    const subpanelContent = {};
    for (const id of on) {
      if (typeOf(id) === 'hints') subpanelContent[id] = { hints: lines(hints) };
      if (typeOf(id) === 'resources') subpanelContent[id] = { links: parseLinks(links) };
    }
    const config = layout === 'content' || isQuiz ? {} : { ...page.config, systemPrompt: prompt || undefined, modelId: modelId === '' ? undefined : modelId, thinking: thinking && !cantThink ? true : undefined, ...(layout === 'agent' ? { subpanels: on, subpanelContent } : { subpanels: undefined, subpanelContent: undefined }), ...(layout === 'agent_file' ? { fileName: fileName || undefined, fileContent: fileContent || undefined } : { fileName: undefined, fileContent: undefined }) };
    if (badFileName) { setMsg('Use a plain file name such as main.py (no folders).'); return; }
    try { onSaved(await put(`/api/courses/${courseId}/pages/${page.id}`, { title, layout, content, config, moduleId: moduleId === '' ? null : moduleId })); setMsg('Saved'); } catch (e) { setMsg(`Could not save (${e.body?.error || 'error'})`); }
  };
  return (
    <Stack spacing={2}>
      <TextField label="Page title" value={title} onChange={(e) => setTitle(e.target.value)} />
      {modules.length > 0 && <FormControl size="small"><InputLabel id="page-module">Module</InputLabel>
        <Select labelId="page-module" label="Module" value={moduleId} onChange={(e) => setModuleId(e.target.value)}><MenuItem value="">None (top level)</MenuItem>{modules.map((m) => <MenuItem key={m.id} value={m.id}>{m.title}</MenuItem>)}</Select>
      </FormControl>}
      {!isQuiz && <FormControl size="small"><InputLabel id="layout-l">Layout</InputLabel>
        <Select labelId="layout-l" label="Layout" value={layout} onChange={(e) => setLayout(e.target.value)}>{LAYOUTS.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}</Select>
      </FormControl>}
      {isQuiz && <Typography variant="body2" color="text.secondary">This page is an assessment. Learners read this text first, then take the assessment below it.</Typography>}
      <RichEditor key={page.id} doc={page.content} onChange={setContent} />
      {layout !== 'content' && !isQuiz && (
        <FormControl size="small"><InputLabel id="page-model">{layout === 'chat' ? 'Chat model' : layout === 'agent_file' ? 'Assistant model' : 'Tutor model'}</InputLabel>
          <Select labelId="page-model" label={layout === 'chat' ? 'Chat model' : layout === 'agent_file' ? 'Assistant model' : 'Tutor model'} value={modelId === '' || models.some((m) => m.id === modelId) ? modelId : ''} onChange={(e) => setModelId(e.target.value)}>
            <MenuItem value="">Platform default</MenuItem>{models.map((m) => <MenuItem key={m.id} value={m.id}>{m.label} ({m.provider})</MenuItem>)}
          </Select>
          <FormHelperText>The model learners talk to on this page. If a learner’s role can’t use it, they get an error, so pick one every enrolled role can use.</FormHelperText>
        </FormControl>
      )}
      {layout !== 'content' && !isQuiz && (
        <FormControl>
          <FormControlLabel label="Show the model thinking before it answers" control={<Switch checked={thinking && !cantThink} disabled={cantThink} onChange={(e) => setThinking(e.target.checked)} slotProps={{ input: { 'aria-label': 'Thinking' } }} />} />
          <FormHelperText>{cantThink ? 'Extended thinking is not enabled for this model. An administrator can turn it on in the model settings.' : thinking ? 'Learners see the model’s thinking stream in first, then the answer. Replies take longer to start.' : 'Off: the answer starts streaming right away.'}</FormHelperText>
        </FormControl>
      )}
      {layout !== 'content' && !isQuiz && <TextField multiline minRows={3} label={layout === 'chat' ? 'Chat instructions (hidden from learners)' : layout === 'agent_file' ? 'Assistant instructions (hidden from learners)' : 'Tutor instructions (hidden from learners)'} value={prompt} onChange={(e) => setPrompt(e.target.value)} />}
      {layout === 'agent_file' && (
        <Stack spacing={1}>
          <Typography variant="subtitle2" component="h3">Editor file</Typography>
          <TextField size="small" label="File name" placeholder="main.txt" value={fileName} error={badFileName} onChange={(e) => setFileName(e.target.value)}
            helperText={badFileName ? 'Use a plain file name such as main.py (no folders).' : 'The extension sets the editor’s language, for example main.py or index.html.'} />
          <TextField multiline minRows={6} label="Starting text or code" value={fileContent} onChange={(e) => setFileContent(e.target.value)} slotProps={{ htmlInput: { style: { fontFamily: 'monospace' }, maxLength: 200000 } }}
            helperText="Each learner gets their own copy of this file. The assistant under the editor can read and change only that file." />
        </Stack>
      )}
      {layout === 'agent' && (
        <Stack spacing={1}>
          <Typography variant="subtitle2" component="h3">Tutor panels shown beside the chat</Typography>
          <FormGroup row>{subpanels.map((s) => <FormControlLabel key={s.id} label={s.label} control={<Checkbox checked={on.includes(s.id)} onChange={(e) => setOn(e.target.checked ? [...on, s.id] : on.filter((x) => x !== s.id))} />} />)}</FormGroup>
          {on.some((id) => typeOf(id) === 'hints') && <TextField multiline minRows={3} label="Hints (one per line, shown one at a time)" value={hints} onChange={(e) => setHints(e.target.value)} />}
          {on.some((id) => typeOf(id) === 'resources') && <TextField multiline minRows={3} label="Resources (one per line: Title | https://address)" value={links} onChange={(e) => setLinks(e.target.value)} />}
        </Stack>
      )}
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}><Button variant="contained" onClick={save}>Save page</Button><Typography role="status" variant="body2">{msg}</Typography></Stack>
      {isQuiz && <><Divider /><AssessmentEditor courseId={courseId} assessmentId={page.assessmentId} onChanged={onSaved} /></>}
    </Stack>
  );
}

function Settings({ course, onChange }) {
  const nav = useNavigate();
  const [title, setTitle] = useState(course.title); const [description, setDescription] = useState(course.description);
  const save = async (status) => onChange(await put(`/api/courses/${course.id}`, { title, description, status: status ?? course.status }));
  return (
    <Stack spacing={2} sx={{ maxWidth: 600 }}>
      <TextField label="Course title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <TextField label="Description" multiline minRows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Button variant="contained" onClick={() => save()}>Save</Button>
        <Chip label={course.status} />
        {course.status !== 'published' ? <Button onClick={() => save('published')}>Publish</Button> : <Button onClick={() => save('draft')}>Unpublish</Button>}
        <Box sx={{ flexGrow: 1 }} />
        <Button color="error" onClick={async () => { if (window.confirm(`Delete "${course.title}" and all its pages?`)) { await del(`/api/courses/${course.id}`); nav('/courses'); } }}>Delete course</Button>
      </Stack>
    </Stack>
  );
}

function Enrollment({ courseId }) {
  const { can } = useAuth();
  const [rows, setRows] = useState([]); const [type, setType] = useState('role'); const [value, setValue] = useState(''); const [person, setPerson] = useState(null); const [error, setError] = useState('');
  const load = useCallback(() => get(`/api/courses/${courseId}/enrollments`).then(setRows), [courseId]);
  useEffect(() => { load(); }, [load]);
  const add = async () => { setError(''); try { await post(`/api/courses/${courseId}/enrollments`, { type, id: type === 'user' ? person.id : value.trim() }); setValue(''); setPerson(null); load(); } catch (e) { setError(e.body?.error || 'failed'); } };
  const types = [['role', 'Role (name)'], ['user', 'Person'], ...(can('course.admin') ? [['saml_group', 'SAML group']] : [])];
  return (
    <Stack spacing={2} sx={{ maxWidth: 600 }}>
      <Typography variant="body2" color="text.secondary">Learners need the course published and one of these assignments. </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <Stack direction="row" spacing={1}>
        <FormControl size="small" sx={{ minWidth: 160 }}><InputLabel id="et">Assign to</InputLabel>
          <Select labelId="et" label="Assign to" value={type} onChange={(e) => setType(e.target.value)}>{types.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}</Select></FormControl>
        {type === 'user' ? <UserPicker value={person} onPick={setPerson} sx={{ flexGrow: 1 }} label="Find a person" />
          : <TextField size="small" label={type === 'role' ? 'Role name' : 'Group name'} value={value} onChange={(e) => setValue(e.target.value)} sx={{ flexGrow: 1 }} />}
        <Button variant="contained" disabled={type === 'user' ? !person : !value.trim()} onClick={add}>Add</Button>
      </Stack>
      {rows.map((r) => (
        <Stack key={`${r.type}:${r.id}`} direction="row" sx={{ alignItems: 'center' }}>
          <Typography sx={{ flexGrow: 1 }}>{r.type === 'user' ? `User: ${r.displayName || r.username || r.id}` : `${r.type === 'role' ? 'Role' : 'SAML group'}: ${r.id}`}</Typography>
          <Button size="small" color="error" onClick={async () => { await api('DELETE', `/api/courses/${courseId}/enrollments`, { type: r.type, id: r.id }); load(); }}>Remove</Button>
        </Stack>
      ))}
    </Stack>
  );
}

// Up and down buttons for one row of the outline; `onMove(index, direction)`.
function Arrows({ name, idx, count, onMove }) {
  return (<>
    <IconButton size="small" aria-label={`Move ${name} up`} disabled={idx === 0} onClick={() => onMove(idx, -1)}><ArrowUpwardIcon fontSize="inherit" /></IconButton>
    <IconButton size="small" aria-label={`Move ${name} down`} disabled={idx === count - 1} onClick={() => onMove(idx, 1)}><ArrowDownwardIcon fontSize="inherit" /></IconButton></>);
}

export default function Author() {
  const { id } = useParams();
  const [renaming, setRenaming] = useState(null); const [course, setCourse] = useState(null); const [tab, setTab] = useState('pages'); const [sel, setSel] = useState(null); const [error, setError] = useState('');
  const load = useCallback(() => get(`/api/courses/${id}`).then((c) => { setCourse(c); setSel((s) => s ?? c.pages[0]?.id ?? null); }).catch((e) => setError(e.body?.error || 'failed')), [id]);
  useEffect(() => { load(); }, [load]);
  if (error) return <Box sx={{ p: 3 }}><Alert severity="error">{error}</Alert></Box>;
  if (!course) return null;
  const pages = course.pages; const page = pages.find((p) => p.id === sel);
  const byId = new Map(pages.map((p) => [p.id, p])); const outline = course.outline || pages.map((p) => ({ type: 'page', id: p.id }));
  const modules = outline.filter((i) => i.type === 'module');
  const addPage = async (moduleId) => { const p = await post(`/api/courses/${id}/pages`, { title: `Page ${pages.length + 1}`, ...(moduleId ? { moduleId } : {}) }); setSel(p.id); load(); };
  const addAssessment = async (moduleId) => { const a = await post(`/api/courses/${id}/assessments`, { title: `Assessment ${pages.filter((p) => p.layout === 'assessment').length + 1}`, ...(moduleId ? { moduleId } : {}) }); setSel(a.pageId); load(); };
  const addModule = async () => { await post(`/api/courses/${id}/modules`, { title: `Module ${modules.length + 1}` }); load(); };
  // Reordering and moving between modules is one call that sends the whole outline back.
  const saveOutline = async (items) => { await put(`/api/courses/${id}/outline`, { items: items.map((i) => (i.type === 'page' ? { type: 'page', id: i.id } : { type: 'module', id: i.id, pages: i.pages })) }); load(); };
  const swap = (a, i, d) => { const c = [...a]; [c[i], c[i + d]] = [c[i + d], c[i]]; return c; };
  const moveTop = (i, d) => saveOutline(swap(outline, i, d));
  const moveIn = (mi, k, d) => saveOutline(outline.map((m, n) => (n === mi ? { ...m, pages: swap(m.pages, k, d) } : m)));
  const removeModule = async (m) => { if (window.confirm(`Delete the module "${m.title}"? Its ${m.pages.length} page${m.pages.length === 1 ? '' : 's'} will move to the top level.`)) { await del(`/api/courses/${id}/modules/${m.id}`); load(); } };
  const remove = async () => { if (window.confirm(page.layout === 'assessment' ? `Delete the assessment "${page.title}", its questions and every attempt at it?` : `Delete page "${page.title}"?`)) { await del(`/api/courses/${id}/pages/${page.id}`); setSel(null); load(); } };
  return (
    <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center', mb: 1 }}>
        <Button component={RouterLink} to="/courses" size="small">← Courses</Button>
        <Typography variant="h5" component="h1" sx={{ flexGrow: 1 }}>{course.title}</Typography>
        <Button component={RouterLink} to={`/courses/${id}/preview`} variant="outlined" size="small">Preview as learner</Button>
      </Stack>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab value="pages" label="Pages" /><Tab value="enroll" label="Enrollment" /><Tab value="settings" label="Settings" />
      </Tabs>
      {tab === 'settings' && <Settings course={course} onChange={(c) => setCourse((o) => ({ ...o, ...c }))} />}
      {tab === 'enroll' && <Enrollment courseId={id} />}
      {tab === 'pages' && (
        <Box sx={{ display: 'grid', gridTemplateColumns: '260px minmax(0,1fr)', gap: 3 }}>
          <Stack spacing={0.5} component="nav" aria-label="Pages">
            {outline.map((item, i) => {
              const row = (p, arrows, indent) => (
                <Stack key={p.id} direction="row" sx={{ alignItems: 'center', pl: indent ? 2 : 0 }}>
                  <Button fullWidth sx={{ justifyContent: 'flex-start', textAlign: 'left', textTransform: 'none' }} variant={p.id === sel ? 'contained' : 'text'} onClick={() => setSel(p.id)}>{p.title}{p.layout === 'assessment' && <Typography component="span" variant="caption" sx={{ ml: 1, opacity: 0.8 }}>Assessment</Typography>}</Button>{arrows}
                </Stack>);
              if (item.type === 'page') { const p = byId.get(item.id); return row(p, <Arrows name={p.title} idx={i} count={outline.length} onMove={moveTop} />, false); }
              return (
                <Box key={`m${item.id}`} role="group" aria-label={`Module ${item.title}`} sx={{ borderLeft: 2, borderColor: 'divider', pl: 0.5, my: 0.5 }}>
                  <Stack direction="row" sx={{ alignItems: 'center' }}>
                    <Typography variant="subtitle2" component="h3" sx={{ flexGrow: 1, pl: 1 }} noWrap>{item.title}</Typography>
                    <Button size="small" onClick={() => setRenaming(item)} aria-label={`Rename module ${item.title}`} sx={{ minWidth: 0, textTransform: 'none' }}>Rename</Button>
                    <Button size="small" color="error" onClick={() => removeModule(item)} aria-label={`Delete module ${item.title}`} sx={{ minWidth: 0, textTransform: 'none' }}>Delete</Button>
                    <Arrows name={`module ${item.title}`} idx={i} count={outline.length} onMove={moveTop} />
                  </Stack>
                  {item.pages.map((pid, k) => row(byId.get(pid), <Arrows name={byId.get(pid).title} idx={k} count={item.pages.length} onMove={(_, d) => moveIn(i, k, d)} />, true))}
                  <Stack direction="row" sx={{ ml: 2 }}>
                    <Button size="small" onClick={() => addPage(item.id)} aria-label={`Add page to ${item.title}`} sx={{ textTransform: 'none' }}>Add page to module</Button>
                    <Button size="small" onClick={() => addAssessment(item.id)} aria-label={`Add assessment to ${item.title}`} sx={{ textTransform: 'none' }}>Add assessment</Button>
                  </Stack>
                </Box>
              );
            })}
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}><Button onClick={() => addPage()}>Add page</Button><Button onClick={() => addAssessment()}>Add assessment</Button><Button onClick={addModule}>Add module</Button></Stack>
          </Stack>
          {page ? (
            <Box><PageEditor key={page.id} courseId={id} page={page} modules={modules} subpanels={course.subpanels} onSaved={() => load()} /><Button color="error" size="small" sx={{ mt: 2 }} onClick={remove}>Delete page</Button></Box>
          ) : <Typography color="text.secondary">Add a page to start building the course.</Typography>}
        </Box>
      )}
      {renaming && <PromptDialog title="Rename module" label="Module name" initial={renaming.title} okLabel="Rename" onClose={() => setRenaming(null)} onOk={async (v) => { const m = renaming; setRenaming(null); await put(`/api/courses/${id}/modules/${m.id}`, { title: v }); load(); }} />}
    </Box>
  );
}
