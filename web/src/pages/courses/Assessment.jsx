import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Checkbox, Chip, CircularProgress, FormControl, FormControlLabel, FormGroup, FormLabel, List, ListItem, ListItemText, Paper, Radio, RadioGroup, Stack, TextField, Typography } from '@mui/material';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { get, post } from '../../api.js';
import SectionShell from '../../components/SectionShell.jsx';
import Markdown from '../../components/Markdown.jsx';

const ERR = { attempts_exhausted: 'You have used all the attempts for this assessment.', assessment_empty: 'This assessment has no questions yet.', already_submitted: 'This attempt was already submitted.', course_not_found: 'Assessment not found.' };
const errText = (e) => ERR[e.body?.error] || `Something went wrong (${e.body?.error || 'error'}).`;
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

// An agentic-coding exercise: the learner works in their own workspace with the agent, then submits; nothing is typed here.
function Exercise({ q, result }) {
  const ex = q.exercise; const r = q.response;
  return (
    <Stack spacing={1.5}>
      <Markdown>{ex.brief}</Markdown>
      {!result && ex.rules?.length > 0 && (
        <Box>
          <Typography variant="subtitle2" component="h3">Rules for the agent</Typography>
          <Box component="ul" sx={{ m: 0, pl: 3 }}>{ex.rules.map((t) => <li key={t}>{t}</li>)}</Box>
        </Box>
      )}
      <Box>
        <Typography variant="subtitle2" component="h3">How you will score</Typography>
        <List dense disablePadding>
          {ex.criteria.map((c, i) => {
            const check = c.kind === 'check' ? r?.checks?.[ex.criteria.filter((x) => x.kind === 'check').indexOf(c)] : null;
            const ri = ex.criteria.filter((x) => x.kind === 'rubric').indexOf(c);
            const mark = result && c.kind === 'check' ? (check?.passed ? '✓ ' : '✗ ') : '';
            const rub = result && c.kind === 'rubric' && r?.rubricScores ? ` — ${r.rubricScores[ri]} of ${c.points}` : '';
            return <ListItem key={i} disableGutters><ListItemText primary={`${mark}${c.label} (${c.points} ${c.points === 1 ? 'point' : 'points'}${c.kind === 'rubric' ? ', marked by your instructor' : ', checked automatically'})${rub}`} secondary={result && check && !check.passed ? check.detail : null} /></ListItem>;
          })}
        </List>
      </Box>
      {!result && (ex.workspace?.projectId
        ? (ex.canUseAgent
          ? <Box><Button variant="outlined" component={RouterLink} to={`/?project=${ex.workspace.projectId}`}>Open your workspace in the agent</Button>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>Your work is saved as you go. Come back here and submit when you are done.</Typography></Box>
          : <Alert severity="warning">Your role does not include the agent, so you cannot work in the workspace. Ask an administrator for access.</Alert>)
        : <Alert severity="warning">The workspace for this exercise is not available.</Alert>)}
    </Stack>
  );
}

function Question({ q, n, value, onChange, result }) {
  const done = !!result;
  const label = `${n}. ${q.prompt} (${q.points} ${q.points === 1 ? 'point' : 'points'})`;
  let input;
  if (q.type === 'mcq' && q.multi) {
    const chosen = value?.choices || [];
    input = <FormGroup>{q.options.map((o, i) => <FormControlLabel key={i} label={o} control={<Checkbox disabled={done} checked={(done ? q.response?.choices : chosen)?.includes(i) || false}
      onChange={(e) => onChange({ choices: e.target.checked ? [...chosen, i] : chosen.filter((x) => x !== i) })} />} />)}</FormGroup>;
  } else if (q.type === 'mcq' || q.type === 'tf') {
    const opts = q.type === 'tf' ? ['True', 'False'] : q.options;
    const cur = q.type === 'tf' ? (done ? q.response?.value : value?.value) : (done ? q.response?.choices?.[0] : value?.choices?.[0]);
    const val = q.type === 'tf' ? (cur === undefined || cur === null ? '' : cur ? '0' : '1') : (cur ?? '') === '' ? '' : String(cur);
    input = (
      <RadioGroup value={val} onChange={(e) => { const i = Number(e.target.value); onChange(q.type === 'tf' ? { value: i === 0 } : { choices: [i] }); }}>
        {opts.map((o, i) => <FormControlLabel key={i} value={String(i)} control={<Radio disabled={done} />} label={o} />)}
      </RadioGroup>
    );
  } else if (q.type === 'exercise') {
    input = <Exercise q={q} result={done} />;
  } else {
    input = <TextField multiline minRows={4} fullWidth disabled={done} label="Your answer" value={(done ? q.response?.text : value?.text) || ''} onChange={(e) => onChange({ text: e.target.value })} slotProps={{ htmlInput: { maxLength: 10000 } }} />;
  }
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <FormControl component="fieldset" fullWidth><FormLabel component="legend" sx={{ color: 'text.primary', mb: 1 }}>{label}</FormLabel>{input}</FormControl>
      {done && (
        <Box sx={{ mt: 1 }}>
          {q.earned == null ? <Chip size="small" label="Waiting for your instructor" />
            : <Chip size="small" color={q.earned === q.points ? 'success' : q.earned > 0 ? 'warning' : 'error'} label={`${fmt(q.earned)} of ${q.points}`} />}
          {q.feedback && <Typography variant="body2" sx={{ mt: 1 }}>Feedback: {q.feedback}</Typography>}
        </Box>
      )}
    </Paper>
  );
}

// The assessment itself (start, answer, submit, results). It shows on an assessment page in the course, and on its own at the old address.
// `onSubmitted` lets the course page refresh which pages are complete.
export function AssessmentRunner({ id, aid, onSubmitted }) {
  const [info, setInfo] = useState(null); const [attempt, setAttempt] = useState(null); const [answers, setAnswers] = useState({}); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = useCallback(() => get(`/api/courses/${id}/assessments`).then((l) => setInfo(l.find((a) => String(a.id) === String(aid)) || false)).catch((e) => setError(errText(e))), [id, aid]);
  useEffect(() => { setAttempt(null); setAnswers({}); load(); }, [load]);
  const run = async (fn) => { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(errText(e)); } finally { setBusy(false); } };
  const start = () => run(async () => { setAnswers({}); setAttempt(await post(`/api/courses/${id}/assessments/${aid}/attempts`)); });
  const submit = () => run(async () => { setAttempt(await post(`/api/courses/${id}/attempts/${attempt.id}/submit`, { answers })); load(); onSubmitted?.(); });

  const body = () => {
    if (error && !info) return <Alert severity="error">{error}</Alert>;
    if (info === null) return <CircularProgress aria-label="Loading" />;
    if (info === false) return <Alert severity="error">Assessment not found.</Alert>;
    const left = info.maxAttempts ? Math.max(0, info.maxAttempts - info.attemptsUsed) : null;
    if (attempt?.status === 'in_progress') {
      return (
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">Answer what you can; blank answers score zero. You cannot change answers after you submit.{attempt.questions.some((q) => q.type === 'exercise') && ' For an exercise, submitting takes a snapshot of your workspace and agent sessions and checks them.'}</Typography>
          {attempt.questions.map((q, i) => <Question key={q.id} q={q} n={i + 1} value={answers[q.id]} onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} />)}
          <Box><Button variant="contained" disabled={busy} onClick={submit}>Submit answers</Button></Box>
        </Stack>
      );
    }
    if (attempt) {
      return (
        <Stack spacing={2}>
          <Alert severity={attempt.status === 'submitted' ? 'info' : attempt.passed === false ? 'warning' : 'success'}>
            {attempt.status === 'submitted' ? `Submitted. Your score so far is ${fmt(attempt.score)}%. Your instructor still needs to grade some answers.`
              : attempt.mode === 'unscored' ? (attempt.passPct == null ? 'Submitted. See which answers were right below.' : `${attempt.passed ? 'You reached the pass score.' : 'You did not reach the pass score this time.'}`)
              : attempt.passPct == null ? `Your score: ${fmt(attempt.score)}%.`
              : `Your score: ${fmt(attempt.score)}% (pass mark ${attempt.passPct}%). ${attempt.passed ? 'You passed.' : 'You did not pass this time.'}`}
          </Alert>
          {attempt.questions.map((q, i) => <Question key={q.id} q={q} n={i + 1} result />)}
          {(left === null || left > 0) && <Box><Button variant="outlined" disabled={busy} onClick={start}>Try again</Button></Box>}
        </Stack>
      );
    }
    return (
      <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
        <Typography>{info.questionCount} questions{info.mode === 'unscored' ? ' (practice: no score is shown).' : `, ${info.totalPoints} points.`}{info.passPct != null && ` Pass score ${info.passPct}%.`}</Typography>
        <Typography>{info.maxAttempts ? `${info.attemptsUsed} of ${info.maxAttempts} attempts used; your best score counts.` : `${info.attemptsUsed} attempts so far (no limit).`}{info.bestScore != null && ` Best score: ${fmt(info.bestScore)}%.`}</Typography>
        {info.passed && <Chip color="success" label={info.passPct == null ? 'Completed' : 'Passed'} />}
        {info.awaitingGrade && <Chip label="Some answers are waiting to be graded" />}
        <Button variant="contained" disabled={busy || left === 0 || !info.questionCount} onClick={start}>{info.inProgress ? 'Resume attempt' : info.attemptsUsed ? 'Start another attempt' : 'Start'}</Button>
        {left === 0 && <Typography color="text.secondary">No attempts left.</Typography>}
      </Stack>
    );
  };
  return (
    <>
      {error && info && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
      {body()}
    </>
  );
}

// Old links to /courses/:id/assessment/:aid still work: the assessment shown on its own page.
export default function Assessment() {
  const { id, aid } = useParams();
  const [title, setTitle] = useState('');
  useEffect(() => { get(`/api/courses/${id}/assessments`).then((l) => setTitle(l.find((a) => String(a.id) === String(aid))?.title || '')).catch(() => {}); }, [id, aid]);
  return (
    <SectionShell ariaLabel="Assessment" items={[{ to: `/courses/${id}`, label: '← Back to course' }]}>
      <Typography variant="h5" component="h1" gutterBottom>{title || 'Assessment'}</Typography>
      <AssessmentRunner id={id} aid={aid} />
    </SectionShell>
  );
}
