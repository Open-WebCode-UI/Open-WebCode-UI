import { useCallback, useEffect, useState } from 'react';
import { ToggleButton, ToggleButtonGroup } from '@mui/material';
import { Alert, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, FormControlLabel, FormGroup, IconButton, InputLabel, MenuItem, Select, Stack, TextField, Typography } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { del, get, post, put } from '../../api.js';

const TYPES = { mcq: 'Multiple choice', tf: 'True / false', text: 'Written answer (you grade it)', exercise: 'Agentic-coding exercise' };
const CHECKS = { file_exists: 'File exists', file_missing: 'File does not exist', file_contains: 'File contains text', file_not_contains: 'File does not contain text', file_changed: 'File differs from the starter', used_tool: 'Agent used a tool', prompt_mentions: 'A prompt mentions text' };
const TOOLS = { propose_plan: 'Proposed a plan', write_file: 'Created a file', edit_file: 'Edited a file', run_command: 'Ran a shell command', spawn_agent: 'Used a subagent', create_checkpoint: 'Created a checkpoint', use_skill: 'Used a skill', ask_user: 'Asked the user a question', read_file: 'Read a file', search: 'Searched the project' };
const newCheck = (type) => ({ type, label: '', points: 1, ...(type.startsWith('file_') ? { path: '' } : {}), ...(type === 'file_contains' || type === 'file_not_contains' ? { text: '', ignoreCase: false } : {}), ...(type === 'prompt_mentions' ? { text: '' } : {}), ...(type === 'used_tool' ? { tool: 'propose_plan', min: 1 } : {}) });
const ERR = { assessment_has_attempts: 'Learners have already attempted this assessment, so its questions are locked.', open_ended_questions: 'A pass score or unscored mode needs every question to be scored automatically. Written answers (and exercises with rubric items) can\'t be used with them.', validation_error: 'Check the question: it needs a prompt, and multiple choice needs at least two options and one correct answer.' };
const errText = (e) => ERR[e.body?.error] || `Could not save (${e.body?.error || 'error'}).`;
const fmt = (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(1));

// Agent rule presets (the server holds the same ones). Rules can only take things away from a learner's own role, never add.
const ALL_OFF = ['subagents', 'skills', 'web_search', 'mcp', 'memory'];
const BASE = { version: 1, protectedFiles: [], checkpoints: true, modelId: null, maxSteps: null, maxMessages: null, maxCost: null, timeLimitMin: null };
const PRESETS = {
  plan_only: { ...BASE, preset: 'plan_only', mode: 'plan', requirePlan: false, shell: false, toolDeny: ALL_OFF, git: false },
  guided: { ...BASE, preset: 'guided', mode: 'act', requirePlan: true, shell: false, toolDeny: ALL_OFF, git: false },
  full: { ...BASE, preset: 'full', mode: 'act', requirePlan: false, shell: true, toolDeny: [], git: false },
};
const PRESET_TEXT = { plan_only: 'Plan only: the agent can read and plan but never change files. Teaches prompting and planning.', guided: 'Guided: the agent must propose a plan you approve before it changes files. No shell, git, subagents, web, MCP or memory.', full: "Full agent: the learner's role as it is, including the shell. Git and downloads stay off." };
const TOOL_LABELS = { subagents: 'Subagents', skills: 'Skills', web_search: 'Web search', mcp: 'MCP tools', memory: 'Memory' };
const blank = (type) => ({ type, prompt: '', points: 1, options: ['', ''], correct: [], tfCorrect: true, rubric: '', spec: { brief: '', starterFiles: [], checks: [], rubric: [], policy: PRESETS.guided } });
const fromServer = (q) => ({ id: q.id, type: q.type, prompt: q.prompt, points: q.points, options: q.type === 'mcq' ? q.options : ['', ''], correct: q.type === 'mcq' ? q.correct : [], tfCorrect: q.type === 'tf' ? q.correct : true, rubric: q.rubric || '', spec: q.spec ? { ...q.spec, policy: q.spec.policy || PRESETS.guided } : blank('exercise').spec });
const toBody = (f) => (f.type === 'mcq' ? { type: 'mcq', prompt: f.prompt, points: f.points, options: f.options, correct: f.correct }
  : f.type === 'tf' ? { type: 'tf', prompt: f.prompt, points: f.points, correct: f.tfCorrect } : f.type === 'exercise' ? { type: 'exercise', prompt: f.prompt, spec: f.spec } : { type: 'text', prompt: f.prompt, points: f.points, rubric: f.rubric });

const total = (sp) => sp.checks.reduce((n, c) => n + (Number(c.points) || 0), 0) + sp.rubric.reduce((n, r) => n + (Number(r.points) || 0), 0);

const num = (v) => (v === '' || v == null ? null : Number(v));

// The agent rules for an exercise, with a preview of what a learner in a chosen role could actually do.
function AgentRules({ policy, onChange }) {
  const [models, setModels] = useState([]); const [roles, setRoles] = useState([]); const [role, setRole] = useState('');
  const [preview, setPreview] = useState(null); const [err, setErr] = useState('');
  useEffect(() => {
    Promise.all([get('/api/models'), get('/api/courses-allowed-models').catch(() => ({ allowed: null }))]).then(([r, { allowed }]) => setModels(allowed ? (r.models || []).filter((m) => allowed.includes(m.id)) : r.models || [])).catch(() => {});
    get('/api/courses-roles').then((r) => { setRoles(r); setRole((cur) => cur || (r.includes('developer') ? 'developer' : r[0] || '')); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!role) return undefined;
    let live = true;
    const t = setTimeout(() => post('/api/courses-policy-preview', { policy, role }).then((r) => { if (live) { setPreview(r); setErr(''); } }).catch((e) => { if (live) { setPreview(null); setErr(e.body?.issues?.map((i) => i.message).join('; ') || 'These rules are not valid.'); } }), 250);
    return () => { live = false; clearTimeout(t); };
  }, [policy, role]);
  const set = (v) => onChange({ ...policy, preset: 'custom', ...v });
  const hasProtected = policy.protectedFiles.length > 0;
  return (
    <Stack spacing={1.5} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }}>
      <Typography variant="subtitle2" component="h4">Agent rules</Typography>
      <Typography variant="caption" color="text.secondary">Rules only take things away from the learner's own role; they can never give more. They apply to the exercise workspace and nothing else.</Typography>
      <ToggleButtonGroup exclusive size="small" value={policy.preset} onChange={(_, v) => v && v !== 'custom' && onChange(structuredClone(PRESETS[v]))} aria-label="Rule preset">
        {Object.keys(PRESETS).map((k) => <ToggleButton key={k} value={k}>{{ plan_only: 'Plan only', guided: 'Guided', full: 'Full agent' }[k]}</ToggleButton>)}
        <ToggleButton value="custom" disabled>Custom</ToggleButton>
      </ToggleButtonGroup>
      {PRESET_TEXT[policy.preset] && <Typography variant="body2">{PRESET_TEXT[policy.preset]}</Typography>}
      <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
        <FormControl size="small" sx={{ minWidth: 220 }}><InputLabel id="rl-mode">What the agent may do</InputLabel>
          <Select labelId="rl-mode" label="What the agent may do" value={policy.mode} onChange={(e) => set({ mode: e.target.value, requirePlan: e.target.value === 'plan' ? false : policy.requirePlan })}><MenuItem value="plan">Plan only (read-only)</MenuItem><MenuItem value="act">Plan, then change files</MenuItem></Select></FormControl>
        <FormControlLabel label="Require an approved plan before it changes files" control={<Checkbox disabled={policy.mode === 'plan'} checked={policy.requirePlan} onChange={(e) => set({ requirePlan: e.target.checked })} />} />
      </Stack>
      <FormControlLabel label="Allow shell commands and the terminal" control={<Checkbox checked={policy.shell} disabled={hasProtected} onChange={(e) => set({ shell: e.target.checked })} />} />
      <Box>
        <Typography variant="body2">Turn off for the agent:</Typography>
        <FormGroup row>{Object.entries(TOOL_LABELS).map(([k, l]) => <FormControlLabel key={k} label={l} control={<Checkbox checked={policy.toolDeny.includes(k)} onChange={(e) => set({ toolDeny: e.target.checked ? [...policy.toolDeny, k] : policy.toolDeny.filter((x) => x !== k) })} />} />)}</FormGroup>
      </Box>
      <FormGroup row>
        <FormControlLabel label="Allow Git and downloads" control={<Checkbox checked={policy.git} onChange={(e) => set({ git: e.target.checked })} />} />
        <FormControlLabel label="Allow checkpoints" control={<Checkbox checked={policy.checkpoints} onChange={(e) => set({ checkpoints: e.target.checked })} />} />
      </FormGroup>
      <TextField size="small" multiline minRows={2} label="Protected files and folders (one per line)" value={policy.protectedFiles.join('\n')} disabled={policy.shell}
        helperText={policy.shell ? 'Turn the shell off to protect files: a shell could edit any file.' : 'Nobody can change, move or delete these, including the agent. A folder protects everything in it.'}
        onChange={(e) => set({ protectedFiles: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} />
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
        <TextField size="small" type="number" label="Agent steps per message" value={policy.maxSteps ?? ''} onChange={(e) => set({ maxSteps: num(e.target.value) })} sx={{ width: 190 }} />
        <TextField size="small" type="number" label="Messages to the agent" value={policy.maxMessages ?? ''} onChange={(e) => set({ maxMessages: num(e.target.value) })} sx={{ width: 190 }} />
        <TextField size="small" type="number" label="Spending limit" value={policy.maxCost ?? ''} onChange={(e) => set({ maxCost: num(e.target.value) })} sx={{ width: 150 }} />
        <TextField size="small" type="number" label="Time limit (minutes)" value={policy.timeLimitMin ?? ''} onChange={(e) => set({ timeLimitMin: num(e.target.value) })} sx={{ width: 180 }} />
        <FormControl size="small" sx={{ minWidth: 220 }}><InputLabel id="rl-model">Model</InputLabel>
          <Select labelId="rl-model" label="Model" value={policy.modelId ?? ''} onChange={(e) => set({ modelId: e.target.value === '' ? null : e.target.value })}><MenuItem value="">Learner's choice</MenuItem>{models.map((m) => <MenuItem key={m.id} value={m.id}>{m.label} ({m.provider})</MenuItem>)}</Select></FormControl>
      </Stack>
      <Typography variant="caption" color="text.secondary">Leave a limit empty for no limit. When the time runs out the workspace becomes read-only; the learner can still submit.</Typography>
      <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
          <Typography variant="subtitle2" component="h5">Preview for a learner with the role</Typography>
          <FormControl size="small" sx={{ minWidth: 180 }}><InputLabel id="rl-role">Role</InputLabel><Select labelId="rl-role" label="Role" value={role} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}</Select></FormControl>
        </Stack>
        {err && <Alert severity="error">{err}</Alert>}
        {preview && (
          <Box component="ul" aria-label="What this role can do" sx={{ m: 0, pl: 2.5 }}>
            {preview.abilities.map((a) => <li key={a.label}>{a.allowed ? '✓' : '✗'} {a.label}{!a.role ? ' (this role does not have it)' : a.role && !a.allowed ? ' (turned off by these rules)' : ''}</li>)}
          </Box>
        )}
      </Box>
    </Stack>
  );
}

// The exercise builder: a brief, starter files, automatic checks (read files and the agent transcript; they never run anything) and rubric items you mark by hand.
function ExerciseFields({ spec, onChange }) {
  const set = (v) => onChange({ ...spec, ...v });
  const upd = (key, i, v) => set({ [key]: spec[key].map((x, j) => (j === i ? { ...x, ...v } : x)) });
  const drop = (key, i) => set({ [key]: spec[key].filter((_, j) => j !== i) });
  const [addType, setAddType] = useState('file_exists');
  const pts = (key, i, x) => <TextField size="small" type="number" label="Points" value={x.points} onChange={(e) => upd(key, i, { points: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} sx={{ width: 90 }} />;
  return (
    <Stack spacing={2}>
      <TextField multiline minRows={3} label="Brief for the learner (what to do with the agent)" value={spec.brief} onChange={(e) => set({ brief: e.target.value })} />
      <Box>
        <Typography variant="subtitle2" component="h4">Starter files</Typography>
        <Typography variant="caption" color="text.secondary">Text files placed in the learner's workspace when they start.</Typography>
        {spec.starterFiles.map((f, i) => (
          <Stack key={i} direction="row" spacing={1} sx={{ mt: 1, alignItems: 'flex-start' }}>
            <TextField size="small" label={`Starter file ${i + 1} path`} value={f.path} onChange={(e) => upd('starterFiles', i, { path: e.target.value })} sx={{ width: 220 }} />
            <TextField size="small" multiline minRows={2} fullWidth label={`Starter file ${i + 1} content`} value={f.content} onChange={(e) => upd('starterFiles', i, { content: e.target.value })} />
            <IconButton aria-label={`Remove starter file ${i + 1}`} onClick={() => drop('starterFiles', i)}><DeleteIcon fontSize="small" /></IconButton>
          </Stack>
        ))}
        <Box><Button size="small" disabled={spec.starterFiles.length >= 50} onClick={() => set({ starterFiles: [...spec.starterFiles, { path: '', content: '' }] })}>Add starter file</Button></Box>
      </Box>
      <Box>
        <Typography variant="subtitle2" component="h4">Automatic checks</Typography>
        <Typography variant="caption" color="text.secondary">Checked when the learner submits, against their workspace and agent sessions. Nothing is run.</Typography>
        {spec.checks.map((c, i) => (
          <Stack key={i} direction="row" spacing={1} sx={{ mt: 1, alignItems: 'flex-start', flexWrap: 'wrap', gap: 1 }}>
            <Chip label={CHECKS[c.type]} sx={{ mt: 0.5 }} />
            <TextField size="small" label={`Check ${i + 1} name`} value={c.label} onChange={(e) => upd('checks', i, { label: e.target.value })} />
            {c.path !== undefined && <TextField size="small" label={`Check ${i + 1} file path`} value={c.path} onChange={(e) => upd('checks', i, { path: e.target.value })} />}
            {c.text !== undefined && <TextField size="small" label={`Check ${i + 1} text`} value={c.text} onChange={(e) => upd('checks', i, { text: e.target.value })} />}
            {c.ignoreCase !== undefined && <FormControlLabel label="Ignore case" control={<Checkbox checked={c.ignoreCase} onChange={(e) => upd('checks', i, { ignoreCase: e.target.checked })} />} />}
            {c.tool !== undefined && <>
              <FormControl size="small" sx={{ minWidth: 200 }}><InputLabel id={`tl${i}`}>Agent</InputLabel><Select labelId={`tl${i}`} label="Agent" value={c.tool} onChange={(e) => upd('checks', i, { tool: e.target.value })}>{Object.entries(TOOLS).map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}</Select></FormControl>
              <TextField size="small" type="number" label="At least" value={c.min} onChange={(e) => upd('checks', i, { min: Math.max(1, Number(e.target.value) || 1) })} sx={{ width: 100 }} />
            </>}
            {pts('checks', i, c)}
            <IconButton aria-label={`Remove check ${i + 1}`} onClick={() => drop('checks', i)}><DeleteIcon fontSize="small" /></IconButton>
          </Stack>
        ))}
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <FormControl size="small" sx={{ minWidth: 260 }}><InputLabel id="addchk">Kind of check</InputLabel><Select labelId="addchk" label="Kind of check" value={addType} onChange={(e) => setAddType(e.target.value)}>{Object.entries(CHECKS).map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}</Select></FormControl>
          <Button disabled={spec.checks.length >= 20} onClick={() => set({ checks: [...spec.checks, newCheck(addType)] })}>Add check</Button>
        </Stack>
      </Box>
      <AgentRules policy={spec.policy} onChange={(policy) => set({ policy })} />
      <Box>
        <Typography variant="subtitle2" component="h4">Rubric (you mark these after reading the work)</Typography>
        {spec.rubric.map((r, i) => (
          <Stack key={i} direction="row" spacing={1} sx={{ mt: 1 }}>
            <TextField size="small" fullWidth label={`Rubric item ${i + 1}`} value={r.label} onChange={(e) => upd('rubric', i, { label: e.target.value })} />
            {pts('rubric', i, r)}
            <IconButton aria-label={`Remove rubric item ${i + 1}`} onClick={() => drop('rubric', i)}><DeleteIcon fontSize="small" /></IconButton>
          </Stack>
        ))}
        <Box><Button size="small" disabled={spec.rubric.length >= 10} onClick={() => set({ rubric: [...spec.rubric, { label: '', points: 1 }] })}>Add rubric item</Button></Box>
      </Box>
    </Stack>
  );
}

function QuestionForm({ init, onSave, onCancel, autoOnly = false }) {
  const [f, setF] = useState(init); const set = (v) => setF({ ...f, ...v });
  const opt = (i, v) => set({ options: f.options.map((o, j) => (j === i ? v : o)) });
  const drop = (i) => set({ options: f.options.filter((_, j) => j !== i), correct: f.correct.filter((c) => c !== i).map((c) => (c > i ? c - 1 : c)) });
  const sp = f.spec; const specOk = sp.brief.trim() && sp.checks.length + sp.rubric.length > 0 && sp.starterFiles.every((x) => x.path.trim()) && sp.checks.every((c) => c.label.trim() && (c.path === undefined || c.path.trim()) && (c.text === undefined || c.text.trim())) && sp.rubric.every((r) => r.label.trim());
  const valid = f.prompt.trim() && (f.type !== 'exercise' || specOk) && (f.type !== 'mcq' || (f.options.length >= 2 && f.options.every((o) => o.trim()) && f.correct.length > 0));
  return (
    <Stack spacing={1.5} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }}>
      <Stack direction="row" spacing={1}>
        <FormControl size="small" sx={{ minWidth: 220 }} disabled={!!f.id}><InputLabel id="qt">Question type</InputLabel>
          <Select labelId="qt" label="Question type" value={f.type} onChange={(e) => set({ ...blank(e.target.value), prompt: f.prompt, points: f.points })}>{Object.entries(TYPES).map(([v, l]) => <MenuItem key={v} value={v} disabled={autoOnly && v === 'text'}>{l}</MenuItem>)}</Select></FormControl>
        {f.type === 'exercise' ? <Typography variant="body2" sx={{ alignSelf: 'center' }}>{total(f.spec)} points in total (from the items below)</Typography> : <TextField size="small" type="number" label="Points" value={f.points} onChange={(e) => set({ points: Math.max(1, Number(e.target.value) || 1) })} sx={{ width: 100 }} />}
      </Stack>
      <TextField multiline minRows={2} label="Question" value={f.prompt} onChange={(e) => set({ prompt: e.target.value })} />
      {f.type === 'mcq' && (
        <Stack spacing={1}>
          <Typography variant="caption" color="text.secondary">Tick every correct option. With one tick learners pick one answer; with more they pick several, and must get them all.</Typography>
          {f.options.map((o, i) => (
            <Stack key={i} direction="row" sx={{ alignItems: 'center' }}>
              <Checkbox checked={f.correct.includes(i)} slotProps={{ input: { 'aria-label': `Option ${i + 1} is correct` } }} onChange={(e) => set({ correct: e.target.checked ? [...f.correct, i] : f.correct.filter((c) => c !== i) })} />
              <TextField size="small" fullWidth label={`Option ${i + 1}`} value={o} onChange={(e) => opt(i, e.target.value)} />
              <IconButton aria-label={`Remove option ${i + 1}`} disabled={f.options.length <= 2} onClick={() => drop(i)}><DeleteIcon fontSize="small" /></IconButton>
            </Stack>
          ))}
          <Box><Button size="small" disabled={f.options.length >= 10} onClick={() => set({ options: [...f.options, ''] })}>Add option</Button></Box>
        </Stack>
      )}
      {f.type === 'tf' && <FormControl size="small" sx={{ maxWidth: 220 }}><InputLabel id="tfc">Correct answer</InputLabel><Select labelId="tfc" label="Correct answer" value={f.tfCorrect ? 'true' : 'false'} onChange={(e) => set({ tfCorrect: e.target.value === 'true' })}><MenuItem value="true">True</MenuItem><MenuItem value="false">False</MenuItem></Select></FormControl>}
      {f.type === 'exercise' && <ExerciseFields spec={f.spec} onChange={(spec) => set({ spec })} />}
      {f.type === 'text' && <TextField multiline minRows={2} label="Grading notes (only you see these)" value={f.rubric} onChange={(e) => set({ rubric: e.target.value })} />}
      <Stack direction="row" spacing={1}><Button variant="contained" disabled={!valid} onClick={() => onSave(toBody(f), f.id)}>{f.id ? 'Save question' : 'Add question'}</Button><Button onClick={onCancel}>Cancel</Button></Stack>
    </Stack>
  );
}

// What an exercise attempt left behind: the submitted workspace (read-only) and the agent sessions.
function Evidence({ courseId, attemptId, qid }) {
  const base = `/api/courses/${courseId}/attempts/${attemptId}/exercises/${qid}`;
  const [files, setFiles] = useState(null); const [file, setFile] = useState(null); const [tr, setTr] = useState(null); const [err, setErr] = useState('');
  const load = (fn) => fn().catch((e) => setErr(e.body?.error === 'no_snapshot' ? 'No snapshot was saved for this attempt.' : 'Could not load.'));
  return (
    <Stack spacing={1}>
      {err && <Alert severity="warning">{err}</Alert>}
      <Stack direction="row" spacing={1}>
        <Button size="small" variant="outlined" onClick={() => load(async () => setFiles((await get(`${base}/files`)).files))}>View submitted files</Button>
        <Button size="small" variant="outlined" onClick={() => load(async () => setTr((await get(`${base}/transcript`)).messages))}>View agent sessions</Button>
      </Stack>
      {files && (
        <Box sx={{ display: 'grid', gridTemplateColumns: '220px minmax(0,1fr)', gap: 1 }}>
          <Stack>{!files.length && <Typography variant="body2">No files.</Typography>}{files.map((f) => <Button key={f.path} size="small" sx={{ justifyContent: 'flex-start', textTransform: 'none' }} onClick={() => load(async () => setFile(await get(`${base}/file?path=${encodeURIComponent(f.path)}`)))}>{f.path}</Button>)}</Stack>
          <Box component="pre" aria-label="File content" sx={{ m: 0, p: 1, bgcolor: 'action.hover', borderRadius: 1, overflow: 'auto', maxHeight: 300, fontSize: 13 }}>{file ? file.content : 'Choose a file.'}</Box>
        </Box>
      )}
      {tr && (
        <Box sx={{ maxHeight: 300, overflow: 'auto' }} role="log" aria-label="Agent sessions">
          {!tr.length && <Typography variant="body2">The learner did not use the agent in this workspace.</Typography>}
          {tr.map((m, i) => (
            <Box key={i} sx={{ mb: 1 }}>
              <Typography variant="caption" color="text.secondary">{m.role === 'user' ? 'Learner' : 'Agent'}{m.tools?.length ? ` · used ${m.tools.map((t) => t.name).join(', ')}` : ''}</Typography>
              <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.content}</Typography>
            </Box>
          ))}
        </Box>
      )}
    </Stack>
  );
}

function GradeDialog({ courseId, attemptId, onClose, onChanged }) {
  const [att, setAtt] = useState(null); const [form, setForm] = useState({}); const [msg, setMsg] = useState('');
  useEffect(() => { get(`/api/courses/${courseId}/attempts/${attemptId}`).then((a) => { setAtt(a); setForm(Object.fromEntries(a.questions.filter((q) => q.type === 'text' || q.type === 'exercise').map((q) => [q.id, q.type === 'exercise' ? { rubric: q.response?.rubricScores || q.exercise.criteria.filter((c) => c.kind === 'rubric').map(() => ''), feedback: q.feedback || '' } : { score: q.earned ?? '', feedback: q.feedback || '' }]))); }); }, [courseId, attemptId]);
  const grade = async (q) => {
    setMsg('');
    const body = q.type === 'exercise' ? { rubric: form[q.id].rubric.map(Number), feedback: form[q.id].feedback } : { score: Number(form[q.id].score), feedback: form[q.id].feedback };
    try { setAtt(await put(`/api/courses/${courseId}/attempts/${attemptId}/answers/${q.id}/grade`, body)); onChanged(); setMsg('Saved'); } catch (e) { setMsg(`Could not save (${e.body?.error || 'error'})`); }
  };
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md" aria-labelledby="grade-title">
      <DialogTitle id="grade-title">Grade answers{att ? ` (${att.status}, score ${fmt(att.score ?? 0)}%)` : ''}</DialogTitle>
      <DialogContent>
        {att?.questions.map((q, i) => (
          <Box key={q.id} sx={{ mb: 2 }}>
            <Typography variant="subtitle2">{i + 1}. {q.prompt}</Typography>
            {q.type === 'exercise' ? (
              <Stack spacing={1.5} sx={{ mt: 1 }}>
                <Typography variant="body2">Automatic checks: {fmt(q.response?.autoScore ?? 0)} of {q.exercise.criteria.filter((c) => c.kind === 'check').reduce((t, c) => t + c.points, 0)} points</Typography>
                <Box component="ul" sx={{ m: 0, pl: 3 }}>{(q.response?.checks || []).map((c, ci) => <li key={ci}>{c.passed ? '✓' : '✗'} {c.label} ({c.points}){c.passed ? '' : ` — ${c.detail}`}</li>)}</Box>
                <Evidence courseId={courseId} attemptId={attemptId} qid={q.id} />
                {form[q.id] && q.exercise.criteria.filter((c) => c.kind === 'rubric').length > 0 && (
                  <Stack spacing={1}>
                    {q.exercise.criteria.filter((c) => c.kind === 'rubric').map((c, ri) => (
                      <TextField key={ri} size="small" type="number" label={`${c.label} (out of ${c.points})`} value={form[q.id].rubric[ri] ?? ''}
                        onChange={(e) => setForm({ ...form, [q.id]: { ...form[q.id], rubric: form[q.id].rubric.map((v, j) => (j === ri ? e.target.value : v)) } })} slotProps={{ htmlInput: { min: 0, max: c.points, step: 0.5 } }} sx={{ maxWidth: 360 }} />
                    ))}
                    <TextField size="small" label="Feedback for the learner" value={form[q.id].feedback} onChange={(e) => setForm({ ...form, [q.id]: { ...form[q.id], feedback: e.target.value } })} />
                    <Box><Button variant="outlined" disabled={form[q.id].rubric.some((v) => v === '' || v == null)} onClick={() => grade(q)}>Save grade</Button></Box>
                  </Stack>
                )}
              </Stack>
            ) : q.type !== 'text' ? <Typography variant="body2" color="text.secondary">Graded automatically: {fmt(q.earned ?? 0)} of {q.points}</Typography> : (
              <Stack spacing={1} sx={{ mt: 1 }}>
                <Box sx={{ p: 1, bgcolor: 'action.hover', borderRadius: 1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{q.response?.text || '(no answer)'}</Box>
                {q.rubric && <Typography variant="caption" color="text.secondary">Your grading notes: {q.rubric}</Typography>}
                <Stack direction="row" spacing={1}>
                  <TextField size="small" type="number" label={`Score out of ${q.points}`} value={form[q.id]?.score ?? ''} onChange={(e) => setForm({ ...form, [q.id]: { ...form[q.id], score: e.target.value } })} slotProps={{ htmlInput: { min: 0, max: q.points, step: 0.5 } }} sx={{ width: 160 }} />
                  <TextField size="small" fullWidth label="Feedback for the learner" value={form[q.id]?.feedback ?? ''} onChange={(e) => setForm({ ...form, [q.id]: { ...form[q.id], feedback: e.target.value } })} />
                  <Button variant="outlined" disabled={form[q.id]?.score === '' || form[q.id]?.score == null} onClick={() => grade(q)}>Save grade</Button>
                </Stack>
              </Stack>
            )}
          </Box>
        ))}
      </DialogContent>
      <DialogActions><Typography role="status" variant="body2" sx={{ flexGrow: 1, pl: 2 }}>{msg}</Typography><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

function Attempts({ courseId, assessment }) {
  const [rows, setRows] = useState(null); const [grading, setGrading] = useState(null);
  const load = useCallback(() => get(`/api/courses/${courseId}/assessments/${assessment.id}/attempts`).then(setRows), [courseId, assessment.id]);
  useEffect(() => { load(); }, [load]);
  if (!rows) return null;
  return (
    <Box>
      <Typography variant="subtitle2" component="h4" gutterBottom>Submitted attempts</Typography>
      {!rows.length && <Typography variant="body2" color="text.secondary">Nothing submitted yet.</Typography>}
      {rows.map((r) => (
        <Stack key={r.id} direction="row" spacing={2} sx={{ alignItems: 'center' }}>
          <Typography sx={{ flexGrow: 1 }}>{r.learner}</Typography>
          <Typography variant="body2">{fmt(r.score ?? 0)}%</Typography>
          <Chip size="small" color={r.status === 'submitted' ? 'warning' : 'default'} label={r.status === 'submitted' ? 'Needs grading' : 'Graded'} />
          <Button size="small" onClick={() => setGrading(r.id)}>{r.status === 'submitted' ? 'Grade' : 'View'}</Button>
        </Stack>
      ))}
      {grading && <GradeDialog courseId={courseId} attemptId={grading} onClose={() => setGrading(null)} onChanged={load} />}
    </Box>
  );
}

// The settings, questions and submitted attempts of one assessment. It shows on the assessment's page, under the title and introduction.
function Panel({ courseId, a, reload }) {
  const [mode, setMode] = useState(a.mode || 'unlimited'); const [pass, setPass] = useState(a.passPct ?? ''); const [max, setMax] = useState(a.maxAttempts || 1);
  // Written answers and exercises with rubric items wait for an instructor, so they can't be mixed with a pass score or unscored mode.
  const hasOpen = a.questions.some((q) => q.type === 'text' || (q.type === 'exercise' && q.spec?.rubric?.length > 0));
  const autoOnly = a.mode === 'unscored' || a.passPct != null;
  const [form, setForm] = useState(null); const [msg, setMsg] = useState(null);
  const base = `/api/courses/${courseId}/assessments/${a.id}`;
  const act = async (fn, ok) => { try { await fn(); setMsg(ok ? { s: 'success', t: ok } : null); setForm(null); reload(); } catch (e) { setMsg({ s: 'error', t: errText(e) }); } };
  return (
    <Stack spacing={2}>
      <Typography variant="subtitle2" component="h3">Assessment · {a.questions.length} question{a.questions.length === 1 ? '' : 's'}{a.locked ? ' · locked' : ''}</Typography>
      {msg && <Alert severity={msg.s} onClose={() => setMsg(null)}>{msg.t}</Alert>}
      {a.locked && <Alert severity="info">Learners have attempted this assessment, so its questions are locked. You can still change the settings below.</Alert>}
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
        <FormControl size="small" sx={{ minWidth: 200 }}><InputLabel id={`md${a.id}`}>Attempts</InputLabel>
          <Select labelId={`md${a.id}`} label="Attempts" value={mode} onChange={(e) => setMode(e.target.value)}>
            <MenuItem value="unlimited">Unlimited attempts</MenuItem>
            <MenuItem value="limited">Limited attempts (best score)</MenuItem>
            <MenuItem value="unscored" disabled={hasOpen}>Unscored (practice)</MenuItem>
          </Select></FormControl>
        {mode === 'limited' && <TextField size="small" type="number" label="Number of attempts" value={max} onChange={(e) => setMax(Math.max(1, Number(e.target.value) || 1))} sx={{ width: 170 }} />}
        {mode !== 'limited' && <TextField size="small" type="number" label="Pass score % (optional)" value={pass} disabled={hasOpen} onChange={(e) => setPass(e.target.value === '' ? '' : Math.min(100, Math.max(0, Number(e.target.value))))} sx={{ width: 190 }}
          helperText={hasOpen ? 'Not available with written answers' : undefined} />}
        <Button variant="outlined" onClick={() => act(() => put(base, { mode, passPct: mode === 'limited' || pass === '' ? null : pass, maxAttempts: mode === 'limited' ? max : 0 }), 'Saved')}>Save settings</Button>
      </Stack>
      <Typography variant="caption" color="text.secondary">Learners finish the assessment on this page, which then counts as complete, or when they reach the pass score if you set one. Learners of an unscored assessment see which answers were right but no score.</Typography>
      {a.questions.map((q, i) => (
        form?.id === q.id ? <QuestionForm key={q.id} autoOnly={autoOnly} init={form} onCancel={() => setForm(null)} onSave={(b, id) => act(() => put(`${base}/questions/${id}`, b), 'Question saved')} /> : (
          <Stack key={q.id} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Typography sx={{ flexGrow: 1 }}>{i + 1}. {q.prompt}</Typography>
            <Chip size="small" label={TYPES[q.type]} /><Chip size="small" label={`${q.points} pt`} />
            <Button size="small" disabled={a.locked} onClick={() => setForm(fromServer(q))}>Edit</Button>
            <Button size="small" color="error" disabled={a.locked} onClick={() => window.confirm('Delete this question?') && act(() => del(`${base}/questions/${q.id}`))}>Delete</Button>
          </Stack>
        )
      ))}
      {form && !form.id ? <QuestionForm autoOnly={autoOnly} init={form} onCancel={() => setForm(null)} onSave={(b) => act(() => post(`${base}/questions`, b), 'Question added')} />
        : !form && <Box><Button disabled={a.locked} onClick={() => setForm(blank('mcq'))}>Add question</Button></Box>}
      <Attempts courseId={courseId} assessment={a} />
    </Stack>
  );
}

// The editor for the assessment on one page of the course. `onChanged` runs after a save, so the page list can refresh.
export default function AssessmentEditor({ courseId, assessmentId, onChanged }) {
  const [a, setA] = useState(null);
  const load = useCallback(() => get(`/api/courses/${courseId}/assessments/manage`).then((l) => setA(l.find((x) => x.id === assessmentId) || false)), [courseId, assessmentId]);
  useEffect(() => { load(); }, [load]);
  if (a === null) return null;
  if (a === false) return <Alert severity="error">This assessment could not be found.</Alert>;
  return <Panel key={`${a.id}:${a.mode}:${a.passPct}:${a.maxAttempts}`} courseId={courseId} a={a} reload={() => { load(); onChanged?.(); }} />;
}
