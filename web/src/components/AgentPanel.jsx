import { useEffect, useMemo, useRef, useState } from 'react';
import MessageInput from './MessageInput.jsx';
import { Box, Stack, ToggleButton, ToggleButtonGroup, TextField, IconButton, Typography, Paper, Chip, Button, Alert, CircularProgress, Dialog, DialogTitle, DialogContent, DialogActions, Tooltip } from '@mui/material';
import MemoryIcon from '@mui/icons-material/PsychologyAltOutlined';
import { useTheme } from '@mui/material/styles';
import SendIcon from '@mui/icons-material/Send';
import ArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import StopIcon from '@mui/icons-material/Stop';
import AutoFixIcon from '@mui/icons-material/AutoFixHigh';
import { get, post } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import AiDisclaimer from './AiDisclaimer.jsx';
import { sessions, useSession } from '../sessionStore.js';
import { lastModel, rememberModel, pickModel, thinkingPref, rememberThinking, effortPref, rememberEffort } from '../modelPref.js';
import CopyButton from './CopyButton.jsx';
import ModelPicker from './ModelPicker.jsx';
import WebSearchToggle from './WebSearchToggle.jsx';
import Markdown from './Markdown.jsx';
import ThinkingBlock from './ThinkingBlock.jsx';
import SkillsMenu from './SkillsMenu.jsx';
import ApprovalPrompt from './ApprovalPrompt.jsx';
import SubagentCard from './SubagentCard.jsx';
import ContextBanner from './ContextBanner.jsx';
import TurnStatus, { QuietNote } from './TurnStatus.jsx';
import ThinkingTips from './ThinkingTips.jsx';
import MemoryManager from './MemoryManager.jsx';
import { useAttachments, AttachButton, AttachmentChips, SentAttachments } from './Attachments.jsx';
import { buildTips } from './tips.js';
import { MediaList, CheckpointChip, ToolCard, ConclusionCard, PlanCard, ModeRequestCard, ModeChangedNote, CompactedCard, ClearedNote, CompactingNote, StoppedCard, StatusCard, MemorySavedNote } from './AgentItems.jsx';

const RESUME_TEXT = 'You were interrupted. Continue from where you left off, without repeating work that is already done.';

// The selected mode button is filled with its color (blue for Plan, amber for Act), matching the banner below it.
const modeSx = (color) => ({ '&.Mui-selected, &.Mui-selected:hover': { bgcolor: `${color}.main`, color: `${color}.contrastText`, fontWeight: 700 } });

// The agent conversation for one project: a flat timeline of messages, one card per tool call, plans, conclusions, and mode
// requests. The conversation itself lives in the session store, so it survives navigating away; this component is a view of it.
// Plan mode is read-only (enforced on the server).
import { useExerciseRules } from '../exerciseRules.js';

export default function AgentPanel({ project, onFileChanged, onCheckpoint, onCommand, onOpenCheckpoint }) {
  const { can, config } = useAuth();
  const pid = project?.id;
  const rules = useExerciseRules(project?.id); // a course exercise's rules, if this workspace belongs to one
  const canAct = can('agent.act') && !rules?.locked && rules?.mode !== 'plan';
  const s = useSession(pid);
  const [models, setModels] = useState([]); const [defaults, setDefaults] = useState({});
  const [thinking, setThinking] = useState(thinkingPref); const [effort, setEffort] = useState(effortPref);
  const [skills, setSkills] = useState([]); const [answer, setAnswer] = useState(''); const [picked, setPicked] = useState([]); const [other, setOther] = useState(false); const [memoryOpen, setMemoryOpen] = useState(false);
  const att = useAttachments();
  const scrollRef = useRef(null); const pinned = useRef(true); const [atBottom, setAtBottom] = useState(true); const inputRef = useRef(null);
  const { mode, items, busy, phase, pendingPlan, context, question } = s;
  const [dismissedMode, setDismissedMode] = useState(null); // the mode whose explainer banner was closed; switching mode shows it again
  // The session's own model wins (it is what the last message used), then the last one picked anywhere, then the admin default.
  const modelId = pickModel(models, s.modelId, lastModel('agent'), defaults.plan);
  const thinkingOn = !!models.find((m) => m.id === modelId)?.supportsThinking && thinking;
  const chooseModel = (id) => { sessions.setModel(pid, id); rememberModel('agent', id); };
  useEffect(() => { get('/api/models').then((r) => { setModels(r.models); setDefaults(r.defaults || {}); }).catch(() => {}); get('/api/skills').then(setSkills).catch(() => {}); }, []);
  useEffect(() => { if (pid) sessions.resume(pid); }, [pid]);
  // Follow the stream while the reader is at the bottom; scrolling up unpins it so earlier lines can be read, and scrolling
  // back down (or "Jump to latest") re-pins it. Content growth fires no scroll event, so a scroll event always means the user.
  const toBottom = () => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; };
  const onScroll = (e) => { const el = e.currentTarget; const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40; pinned.current = near; setAtBottom(near); };
  const jumpToLatest = () => { pinned.current = true; setAtBottom(true); toBottom(); };
  useEffect(() => { if (pinned.current) toBottom(); }, [items, question, phase, busy]);
  useEffect(() => { pinned.current = true; setAtBottom(true); }, [pid]);
  // The IDE reacts to what the agent does (file changes, checkpoints, shell commands) even though the store owns the stream.
  useEffect(() => {
    const offs = [sessions.on('file_changed', (p) => onFileChanged?.(p)), sessions.on('checkpoint', () => onCheckpoint?.()), sessions.on('command', (e) => onCommand?.(e)), sessions.on('turn_end', () => { onFileChanged?.(); onCheckpoint?.(); })];
    return () => offs.forEach((f) => f());
  }, [onFileChanged, onCheckpoint, onCommand]);
  const fun = !!config?.general?.funMode;
  const tips = useMemo(() => buildTips({ skills, can, mode, fun }), [skills, can, mode, fun]);

  const currentModel = models.find((m) => m.id === modelId);
  const send = (text, turnMode = mode, plan = '', resume = false) => {
    pinned.current = true; setAtBottom(true); // sending a message always returns to the live end of the conversation
    const files = text.trim() && !resume ? att.items : [];
    if (files.length) att.clear();
    return sessions.send(pid, { text, mode: turnMode, plan, modelId, thinking: thinkingOn, effort, webSearch: s.webSearch, resume, attachments: files });
  };
  // Changing mode acts on whatever is in the message box straight away; with a pending plan (or a confirmed recommendation)
  // and an empty box, switching to Act simply starts the work, so the user need not type an acknowledgment.
  const switchTo = (next, { force = false } = {}) => {
    if (busy || (next === mode && !force)) return;
    const text = s.draft.trim(), plan = next === 'act' ? pendingPlan : '';
    if (next === 'act' && plan) sessions.approvePlan(pid);
    if (text) return send(text, next, plan);
    if (next === 'act' && (plan || force)) return send(plan ? 'The plan is approved. Implement it now.' : 'Go ahead and make the changes you proposed.', 'act', plan);
    sessions.setMode(pid, next);
    return undefined;
  };
  const respond = async (value) => { const q = question; sessions.clearQuestion(pid); setAnswer(''); setPicked([]); setOther(false); await post('/api/agent/respond', { id: q.id, value }).catch(() => {}); };
  const lastIdx = items.length - 1;

  const render = (it, i) => {
    switch (it.kind) {
      case 'user': return <Paper key={it.id} variant="outlined" sx={{ p: 1.5, bgcolor: 'action.hover' }}><Stack direction="row" alignItems="center"><Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>You</Typography><CopyButton text={it.text} label="Copy prompt" /></Stack><Typography sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} variant="body2">{it.text}</Typography><SentAttachments items={it.attachments} /></Paper>;
      case 'media': return <Paper key={it.id} variant="outlined" sx={{ p: 1.5 }}><MediaList items={it.attachments} /></Paper>;
      case 'assistant': if (!it.thinking?.trim() && !it.text) return null; return (
        <Paper key={it.id} variant="outlined" sx={{ p: 1.5 }}>
          <Stack direction="row" alignItems="center"><Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>Agent</Typography><CopyButton text={it.text} label="Copy response" /></Stack>
          <ThinkingBlock text={it.thinking} live={busy && i === lastIdx && !it.text} />
          {it.text && <Markdown>{it.text}</Markdown>}
        </Paper>);
      case 'tool': return <ToolCard key={it.id} t={it} />;
      case 'subagent': return <SubagentCard key={it.id} item={it} onOpenCheckpoint={onOpenCheckpoint} />;
      case 'skill': return <Chip key={it.id} size="small" icon={<AutoFixIcon />} label={`Skill: ${it.name}`} variant="outlined" sx={{ alignSelf: 'flex-start', ml: 2 }} />;
      case 'checkpoint': return <CheckpointChip key={it.id} cpId={it.cpId} label={it.label} onOpen={onOpenCheckpoint} sx={{ ml: 2 }} />;
      case 'plan': return <PlanCard key={it.id} item={it} canAct={canAct} busy={busy} onApprove={() => switchTo('act', { force: true })} />;
      case 'conclusion': return <ConclusionCard key={it.id} c={it.c} onOpenFile={(p) => sessions.emit('open_file', p)} onFollowUp={busy ? undefined : (t) => { sessions.setDraft(pid, t); inputRef.current?.focus(); }} />;
      case 'mode_request': return <ModeRequestCard key={it.id} item={it} busy={busy} onConfirm={() => { sessions.resolveItem(pid, it.id, 'confirmed'); switchTo('act', { force: true }); }} onDecline={() => sessions.resolveItem(pid, it.id, 'declined')} />;
      case 'mode_changed': return <ModeChangedNote key={it.id} item={it} />;
      case 'compacted': return <CompactedCard key={it.id} item={it} />;
      case 'cleared': return <ClearedNote key={it.id} item={it} />;
      case 'compacting': return <CompactingNote key={it.id} />;
      case 'stopped': return <StoppedCard key={it.id} disabled={busy || !project} onResume={() => send(RESUME_TEXT, mode, '', true)} onDismiss={() => sessions.dismissStopped(pid)} />;
      case 'status': return <StatusCard key={it.id} s={it.status} />;
      case 'memory': return <MemorySavedNote key={it.id} item={it} />;
      case 'notice': return <Alert key={it.id} severity="info">{it.text}</Alert>;
      case 'error': return <Alert key={it.id} severity="error">{it.text}</Alert>;
      default: return null;
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Stack direction="row" spacing={1} useFlexGap sx={{ p: 1, alignItems: 'center', flexWrap: 'wrap', borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}>
        <ToggleButtonGroup data-tour="agent-mode" size="small" sx={{ height: 36, '& .MuiToggleButton-root': { py: 0 } }} exclusive value={mode} disabled={busy} onChange={(_, v) => v && switchTo(v)} aria-label="Agent mode">
          <ToggleButton value="plan" aria-label="Plan mode" sx={modeSx('info')}>Plan</ToggleButton>
          <ToggleButton value="act" disabled={!canAct} aria-label="Act mode" sx={modeSx('warning')}>Act</ToggleButton>
        </ToggleButtonGroup>
        <ModelPicker models={models} value={modelId} onChange={chooseModel} defaults={defaults} kinds={['plan', 'act']} busy={busy} sx={{ flexGrow: 1, height: 36 }}
          effort={effort} onEffort={(v) => { setEffort(v); rememberEffort(v); }} thinking={thinking} onThinking={(v) => { setThinking(v); rememberThinking(v); }}
          extra={<WebSearchToggle value={s.webSearch} disabled={busy} onChange={(v) => sessions.setWebSearch(pid, v)} />} />
        {can('memory.use') && <Tooltip title="Memory: what the agent remembers"><span><IconButton size="small" aria-label="Memory" disabled={!project} onClick={() => setMemoryOpen(true)}><MemoryIcon /></IconButton></span></Tooltip>}
      </Stack>
      {rules && (
        <Alert severity={rules.locked ? 'warning' : 'info'} icon={false} sx={{ py: 0, borderRadius: 0, flexShrink: 0 }} aria-label="Exercise rules">
          <strong>{rules.locked ? (rules.submitted ? 'Exercise submitted: this workspace is read-only.' : 'Time is up: this workspace is read-only. You can still submit.') : 'Exercise rules'}</strong>
          {!rules.locked && <Box component="ul" sx={{ m: 0, pl: 2.5 }}>{rules.summary.map((t) => <li key={t}>{t}</li>)}{rules.deadline && <li>Time limit ends at {new Date(rules.deadline * 1000).toLocaleTimeString()}.</li>}</Box>}
        </Alert>
      )}
      {dismissedMode !== mode && <Alert severity={mode === 'plan' ? 'info' : 'warning'} icon={false} sx={{ py: 0, borderRadius: 0, flexShrink: 0 }} onClose={() => setDismissedMode(mode)}>
        {mode === 'plan' ? 'Plan mode: read-only. The agent can inspect the project but cannot change anything.' : 'Act mode: the agent can edit files. A checkpoint is taken at the start of each turn.'}
        {' '}Switching mode runs whatever is in the message box{pendingPlan ? ', or starts the proposed plan' : ''}.
      </Alert>}
      <Box sx={{ flexGrow: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
      <Box ref={scrollRef} onScroll={onScroll} sx={{ flexGrow: 1, overflowY: 'auto', overflowX: 'hidden', p: 1.5, display: 'flex', flexDirection: 'column', gap: 1, '& > *': { flexShrink: 0, minWidth: 0, maxWidth: '100%' } }} aria-live="polite">
        {!project && <Box sx={{ flexGrow: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', p: 2 }}><Typography sx={{ fontStyle: 'italic' }} color="text.secondary">Select or create a project to start.</Typography></Box>}
        {project && !items.length && <Typography color="text.secondary" variant="body2">Describe what you want to build or change. Type <code>/</code> to see skills such as /code-review, or open the Sessions panel to continue an earlier conversation.</Typography>}
        {items.map((it, i) => {
          const node = render(it, i);
          if (!it.rolledBack || !node) return node;
          // Rolled-back messages stay on screen for reference but are grayed out and no longer sent to the agent.
          return (
            <Box key={it.id} data-rolled-back="true" aria-label="Rolled back" sx={{ opacity: 0.4, filter: 'grayscale(1)', pointerEvents: 'none', userSelect: 'text' }}>
              {!items[i - 1]?.rolledBack && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>Rolled back with a checkpoint. The agent no longer sees what follows.</Typography>}
              {node}
            </Box>
          );
        })}
        {busy && (phase?.name === 'prefill' || (phase?.name === 'sending' && items[lastIdx]?.kind === 'user')) && <TurnStatus phase={phase} />}
        <QuietNote since={sessions.lastEventAt(pid)} show={busy && phase?.name === 'generating' && !(items[lastIdx]?.kind === 'tool' && items[lastIdx].result === undefined && !items[lastIdx].stream)} />
        <ApprovalPrompt />
        {question && (
          <Alert severity="info">
            {question.question}
            {question.options?.length > 0 ? (
              <>
                <Stack direction="row" useFlexGap spacing={1} sx={{ mt: 1, flexWrap: 'wrap' }} role={question.multiple ? 'group' : 'radiogroup'} aria-label="Choices">
                  {question.options.map((o) => question.multiple
                    ? <Chip key={o} label={o} role="checkbox" aria-checked={picked.includes(o)} color={picked.includes(o) ? 'primary' : 'default'} variant={picked.includes(o) ? 'filled' : 'outlined'} onClick={() => setPicked((p) => (p.includes(o) ? p.filter((x) => x !== o) : [...p, o]))} />
                    : <Chip key={o} label={o} role="radio" aria-checked={false} variant="outlined" onClick={() => respond(o)} />)}
                  <Chip label="Other…" role={question.multiple ? 'checkbox' : 'radio'} aria-checked={other} color={other ? 'primary' : 'default'} variant={other ? 'filled' : 'outlined'} onClick={() => setOther((v) => !v)} />
                </Stack>
                {other && <TextField size="small" fullWidth autoFocus sx={{ mt: 1 }} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Write your own answer" slotProps={{ htmlInput: { 'aria-label': 'Your own answer' } }} />}
                {(other || (question.multiple && picked.length > 0)) && (() => {
                  const typed = other ? answer.trim() : '';
                  const parts = question.multiple ? [...picked, ...(typed ? [typed] : [])] : [typed].filter(Boolean);
                  return <Button size="small" sx={{ mt: 1 }} disabled={!parts.length} onClick={() => respond(parts.join(', '))}>{question.multiple ? 'Send choices' : 'Answer'}</Button>;
                })()}
              </>
            ) : (
              <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                <TextField size="small" fullWidth value={answer} onChange={(e) => setAnswer(e.target.value)} slotProps={{ htmlInput: { 'aria-label': 'Your answer' } }} />
                <Button disabled={!answer.trim()} onClick={() => respond(answer)}>Answer</Button>
              </Stack>
            )}
          </Alert>
        )}
      </Box>
      {!atBottom && <Button size="small" variant="contained" startIcon={<ArrowDownIcon />} onClick={jumpToLatest} sx={{ position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)', borderRadius: 4, boxShadow: 3 }}>Jump to latest{busy ? ' (live)' : ''}</Button>}
      </Box>
      <ContextBanner context={context} busy={busy} onCompact={() => send('/compact')} onClear={() => send('/clear')} onNew={() => sessions.newSession(pid)} />
      {busy && <Box sx={{ px: 1.5, py: 0.5 }}><ThinkingTips tips={tips} /></Box>}
      <AttachmentChips att={att} />
      <Stack direction="row" spacing={0.5} sx={{ p: 1, borderTop: 1, borderColor: 'divider', alignItems: 'flex-end' }}>
        <AttachButton model={currentModel} att={att} disabled={!project || busy} />
        <SkillsMenu disabled={!project || busy} onPick={(t) => sessions.setDraft(pid, t + s.draft.replace(/^\/[a-z0-9-]*\s*/, ''))} />
        <MessageInput size="small" maxRows={6} placeholder={mode === 'plan' ? 'Describe what you want to build or change… (or /skill-name)' : 'Tell the agent what to do… (or /skill-name)'} value={s.draft}
          onChange={(v) => sessions.setDraft(pid, v)} onSubmit={() => send(s.draft)} disabled={!project} ref={inputRef} />
        {busy ? <IconButton aria-label="Stop" onClick={() => sessions.stop(pid)}><StopIcon /></IconButton>
          : <IconButton color="primary" aria-label="Send" disabled={!project || !s.draft.trim()} onClick={() => send(s.draft)}><SendIcon /></IconButton>}
        {busy && <CircularProgress size={20} sx={{ alignSelf: 'center' }} />}
      </Stack>
      <AiDisclaimer />
      {memoryOpen && <Dialog open onClose={() => setMemoryOpen(false)} fullWidth maxWidth="sm"><DialogTitle>Memory</DialogTitle><DialogContent><MemoryManager projectId={pid} /></DialogContent><DialogActions><Button onClick={() => setMemoryOpen(false)}>Close</Button></DialogActions></Dialog>}
    </Box>
  );
}
