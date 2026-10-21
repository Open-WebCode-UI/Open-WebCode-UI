import { useEffect, useRef, useState } from 'react';
import { WaitingNote } from './TurnStatus.jsx';
import { attachmentUrl } from '../api.js';
import { Alert, AlertTitle, Box, Button, Chip, CircularProgress, Collapse, IconButton, Paper, Stack, Tooltip, Typography, ButtonBase } from '@mui/material';
import StopCircleIcon from '@mui/icons-material/StopCircleOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import FolderOpenIcon from '@mui/icons-material/FolderOpenOutlined';
import DescriptionIcon from '@mui/icons-material/DescriptionOutlined';
import SearchIcon from '@mui/icons-material/Search';
import EditIcon from '@mui/icons-material/EditOutlined';
import NoteAddIcon from '@mui/icons-material/NoteAddOutlined';
import DeleteIcon from '@mui/icons-material/DeleteOutlined';
import BookmarkIcon from '@mui/icons-material/BookmarkBorder';
import TerminalIcon from '@mui/icons-material/Terminal';
import CompareIcon from '@mui/icons-material/DifferenceOutlined';
import AutoFixIcon from '@mui/icons-material/AutoFixHigh';
import HelpIcon from '@mui/icons-material/HelpOutlined';
import BuildIcon from '@mui/icons-material/Build';
import CheckIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorIcon from '@mui/icons-material/ErrorOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DownloadIcon from '@mui/icons-material/FileDownloadOutlined';
import WarningIcon from '@mui/icons-material/WarningAmberOutlined';
import BlockIcon from '@mui/icons-material/BlockOutlined';
import CopyIcon from '@mui/icons-material/ContentCopy';
import SwapIcon from '@mui/icons-material/SwapHoriz';
import Markdown from './Markdown.jsx';
import CompressIcon from '@mui/icons-material/UnfoldLessOutlined';

// Present/past wording and icon per tool, so each step reads naturally ("Reading src/app.js" -> "Read src/app.js").
const short = (s, n = 70) => (String(s).length > n ? `…${String(s).slice(-n)}` : String(s));
const pth = (p) => (p ? short(p) : 'a file');
const lineRange = (a, b) => (b && Number(b) !== Number(a) ? `lines ${a}–${b}` : `line ${a}`);
export const TOOL_META = {
  list_dir: { icon: FolderOpenIcon, now: (a) => `Listing ${a.path || '.'}`, done: (a) => `Listed ${a.path || '.'}` },
  read_file: { icon: DescriptionIcon, now: (a) => `Reading ${pth(a.path)}`, done: (a) => `Read ${pth(a.path)}${a.start_line ? ` (lines ${a.start_line}–${a.end_line ?? 'end'})` : ''}` },
  search: { icon: SearchIcon, now: (a) => `Searching for “${short(a.pattern, 40)}”`, done: (a) => `Searched for “${short(a.pattern, 40)}”` },
  get_file_metadata: { icon: DescriptionIcon, now: (a) => `Checking ${pth(a.path)}`, done: (a) => `Checked ${pth(a.path)}` },
  list_changes: { icon: CompareIcon, now: () => 'Reviewing changes', done: () => 'Reviewed changes since checkpoint' },
  write_file: { icon: NoteAddIcon, now: (a) => `Writing ${pth(a.path)}`, done: (a) => `Wrote ${pth(a.path)}` },
  edit_file: { icon: EditIcon, now: (a) => `Editing ${pth(a.path)}`, done: (a) => `Edited ${pth(a.path)}` },
  replace_lines: { icon: EditIcon, now: (a) => `Editing ${pth(a.path)}`, done: (a) => `Replaced ${lineRange(a.start_line, a.end_line)} in ${pth(a.path)}` },
  delete_lines: { icon: DeleteIcon, now: (a) => `Editing ${pth(a.path)}`, done: (a) => `Deleted ${lineRange(a.start_line, a.end_line)} in ${pth(a.path)}` },
  insert_lines: { icon: NoteAddIcon, now: (a) => `Editing ${pth(a.path)}`, done: (a) => `Inserted after line ${a.after_line} in ${pth(a.path)}` },
  save_attachment: { icon: NoteAddIcon, now: (a) => `Saving ${pth(a.path)}`, done: (a) => `Saved ${pth(a.path)}` },
  delete_file: { icon: DeleteIcon, now: (a) => `Deleting ${pth(a.path)}`, done: (a) => `Deleted ${pth(a.path)}` },
  create_checkpoint: { icon: BookmarkIcon, now: (a) => `Saving checkpoint “${a.label || ''}”`, done: (a) => `Checkpoint saved: ${a.label || ''}` },
  run_command: { icon: TerminalIcon, now: (a) => `Running ${short(a.command, 60)}`, done: (a) => `Ran ${short(a.command, 60)}` },
  use_skill: { icon: AutoFixIcon, now: (a) => `Loading skill ${a.name}`, done: (a) => `Used skill ${a.name}` },
  ask_user: { icon: HelpIcon, now: () => 'Asking you a question', done: () => 'Asked you a question' },
};
// A checkpoint chip in the conversation; clicking it opens the Checkpoints tab at that entry.
export function CheckpointChip({ cpId, label, onOpen, sx }) {
  return <Chip size="small" icon={<BookmarkIcon />} label={`Checkpoint: ${label}`} variant="outlined" sx={{ alignSelf: 'flex-start', ...sx }}
    {...(cpId && onOpen ? { onClick: () => onOpen(cpId), clickable: true, title: 'Show in Checkpoints' } : {})} />;
}
export const isError = (r) => typeof r === 'string' && r.startsWith('Error');

function DiffLines({ text }) {
  return (
    <Box component="pre" sx={{ m: 0, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {String(text).split('\n').map((l, i) => (
        <Box component="span" key={i} sx={{ display: 'block', ...(l.startsWith('+') && !l.startsWith('+++') ? { bgcolor: 'success.main', color: 'success.contrastText', opacity: 0.9 } : l.startsWith('-') && !l.startsWith('---') ? { bgcolor: 'error.main', color: 'error.contrastText', opacity: 0.9 } : l.startsWith('@@') ? { color: 'info.main' } : {}) }}>{l || ' '}</Box>
      ))}
    </Box>
  );
}
const Pre = ({ children }) => <Box component="pre" sx={{ m: 0, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflow: 'auto' }}>{children}</Box>;

// Shows the end of text that is still being written, following it as it grows.
function LivePre({ text, lines = 60 }) {
  const ref = useRef(null);
  const all = String(text).split('\n'), shown = all.length > lines ? all.slice(-lines) : all;
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [text]);
  return (
    <Box ref={ref} component="pre" data-testid="live-code" sx={{ m: 0, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflow: 'auto' }}>
      {all.length > lines && <Box component="span" sx={{ display: 'block', color: 'text.secondary' }}>{`… ${all.length - lines} earlier lines`}</Box>}
      {shown.join('\n')}<Box component="span" sx={{ opacity: 0.6 }}>▍</Box>
    </Box>
  );
}
function LiveBody({ t }) {
  const s = t.stream || {};
  if (!s.content && !s.new_string && !s.old_string && !s.command && s.raw) return <><Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>Receiving the call…</Typography><LivePre text={s.raw} /></>;
  if (t.name === 'write_file') return s.content ? <><Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>{t.lines + 1} {t.lines ? 'lines' : 'line'} so far</Typography><LivePre text={s.content} /></> : <WaitingNote since={t.since}>{s.path ? `Starting ${s.path}…` : 'Waiting for the model to name the file…'}</WaitingNote>;
  if (t.name === 'edit_file') return s.new_string || s.old_string ? <LivePre text={`${s.old_string ? s.old_string.split('\n').map((l) => `- ${l}`).join('\n') : ''}${s.new_string ? `\n${s.new_string.split('\n').map((l) => `+ ${l}`).join('\n')}` : ''}`.trim()} /> : <WaitingNote since={t.since}>Waiting for the edit…</WaitingNote>;
  if (t.name === 'replace_lines' || t.name === 'insert_lines') return s.content ? <><Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>{t.name === 'insert_lines' ? `Inserting after line ${s.after_line}` : `Replacing ${lineRange(s.start_line, s.end_line)}`}</Typography><LivePre text={s.content.split('\n').map((l) => `+ ${l}`).join('\n')} /></> : <WaitingNote since={t.since}>Waiting for the edit…</WaitingNote>;
  if (t.name === 'delete_lines') return <WaitingNote since={t.since}>{s.start_line ? `Deleting ${lineRange(s.start_line, s.end_line)}…` : 'Waiting for the edit…'}</WaitingNote>;
  if (t.name === 'run_command') return s.command ? <LivePre text={`$ ${s.command}`} /> : <WaitingNote since={t.since}>Waiting for the command…</WaitingNote>;
  return null;
}

// Images, audio and video a tool or the model produced, shown from the stored attachment, each with a download link.
export function MediaList({ items }) {
  return (
    <Stack spacing={1.5} sx={{ mt: 1 }} data-testid="media-list">
      {items.map((m) => (
        <Box key={m.id}>
          {m.kind === 'image' ? <Box component="img" src={attachmentUrl(m.id)} alt={m.name} sx={{ display: 'block', maxWidth: '100%', maxHeight: 360, objectFit: 'contain', borderRadius: 1 }} />
            : m.kind === 'audio' ? <audio controls src={attachmentUrl(m.id)} aria-label={m.name} />
            : m.kind === 'video' ? <video controls src={attachmentUrl(m.id)} aria-label={m.name} style={{ maxWidth: '100%', maxHeight: 360 }} />
            : null}
          <Button size="small" component="a" href={`${attachmentUrl(m.id)}?download=1`} download={m.name} aria-label={`Download ${m.name}`} startIcon={<DownloadIcon fontSize="small" />} sx={{ mt: 0.5 }}>Download</Button>
        </Box>
      ))}
    </Stack>
  );
}

function ToolBody({ t }) {
  const a = t.args || {};
  if (t.stream && t.result === undefined) return <LiveBody t={t} />;
  if (t.name === 'edit_file') return <DiffLines text={`${String(a.old_string || '').split('\n').map((l) => `- ${l}`).join('\n')}\n${String(a.new_string || '').split('\n').map((l) => `+ ${l}`).join('\n')}`} />;
  if (t.name === 'replace_lines' || t.name === 'insert_lines') return <><Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>{t.name === 'insert_lines' ? `After line ${a.after_line}` : lineRange(a.start_line, a.end_line)}</Typography><DiffLines text={String(a.content ?? '').split('\n').map((l) => `+ ${l}`).join('\n')} /></>;
  if (t.name === 'delete_lines') return <Typography variant="body2">{t.result ?? 'Deleting…'}</Typography>;
  if (t.name === 'write_file') return <Typography variant="body2">{a.bytes} bytes written to <code>{a.path}</code></Typography>;
  if (t.name === 'run_command') return <Pre>{`$ ${a.command}\n${t.result ?? ''}`}</Pre>;
  if (t.name === 'list_changes') return <DiffLines text={t.result ?? ''} />;
  if (t.attachments?.length) return <><Pre>{t.result}</Pre><MediaList items={t.attachments} /></>;
  return <Pre>{t.result ?? '(running…)'}</Pre>;
}

// One tool call = one timeline entry: icon, a plain-language title, live status, expandable details.
export function ToolCard({ t }) {
  const meta = TOOL_META[t.name] || { icon: BuildIcon, now: () => `Running ${t.name}`, done: () => `Ran ${t.name}` };
  const done = t.result !== undefined, err = done && isError(t.result);
  const [userOpen, setUserOpen] = useState(null);
  const open = userOpen ?? (err || (!done && !!t.stream)); // failures open themselves, and so does a call that is being written out
  const Icon = meta.icon;
  return (
    <Paper variant="outlined" data-testid="tool-card" data-tool={t.name} data-status={!done ? 'running' : err ? 'error' : 'ok'} sx={{ ml: 2, borderColor: err ? 'error.main' : 'divider', overflow: 'hidden' }}>
      <ButtonBase onClick={() => setUserOpen(!open)} aria-expanded={open} aria-label={(done ? meta.done : meta.now)(t.args || {})} sx={{ width: '100%', justifyContent: 'flex-start', gap: 1, px: 1.25, py: 0.6, textAlign: 'left' }}>
        <Icon fontSize="small" color={err ? 'error' : 'action'} />
        <Typography variant="body2" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>{(done ? meta.done : meta.now)(t.args || {})}</Typography>
        {!done ? <CircularProgress size={14} /> : err ? <ErrorIcon fontSize="small" color="error" /> : <CheckIcon fontSize="small" color="success" />}
        <ExpandMoreIcon fontSize="small" sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </ButtonBase>
      <Collapse in={open} unmountOnExit><Box sx={{ px: 1.5, py: 1, borderTop: 1, borderColor: 'divider', bgcolor: 'action.hover' }}>{err && <Typography variant="caption" color="error" display="block" sx={{ mb: 0.5 }}>{t.result}</Typography>}{!err && <ToolBody t={t} />}</Box></Collapse>
    </Paper>
  );
}

const STATUS = {
  complete: { title: 'All done', color: 'success', Icon: CheckIcon },
  partial: { title: 'Partly done', color: 'warning', Icon: WarningIcon },
  blocked: { title: 'Blocked', color: 'error', Icon: BlockIcon },
};
const FILE_LIMIT = 8;
const Section = ({ title, children }) => <Box sx={{ mt: 1.75 }}><Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1.6, display: 'block' }}>{title}</Typography>{children}</Box>;

// Plain-text version of a conclusion, for the Copy button.
export function conclusionText(c) {
  const t = STATUS[c.status] || STATUS.complete;
  return [`${t.title}`, c.summary, c.needs && `I need from you: ${c.needs}`, c.changes?.length && `Files:\n${c.changes.map((f) => `- ${f}`).join('\n')}`, c.verification && `How I checked: ${c.verification}`, c.next_steps?.length && `Next steps:\n${c.next_steps.map((n) => `- ${n}`).join('\n')}`].filter(Boolean).join('\n\n');
}

// The agent's closing statement, laid out so the outcome is clear at a glance: status first, then the summary, anything the
// agent needs from you, the files involved (click to open), how it checked, and next steps (click to use as your next message).
export function ConclusionCard({ c, onOpenFile, onFollowUp }) {
  const t = STATUS[c.status] || STATUS.complete, Icon = t.Icon;
  const [all, setAll] = useState(false), [copied, setCopied] = useState(false);
  const files = c.changes || [], shown = all ? files : files.slice(0, FILE_LIMIT);
  const copy = async () => { try { await navigator.clipboard.writeText(conclusionText(c)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ } };
  return (
    <Paper elevation={3} data-testid="conclusion" data-status={c.status} sx={{ overflow: 'hidden', borderTop: 4, borderColor: `${t.color}.main` }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 2, pt: 1.25 }}>
        <Icon color={t.color} />
        <Typography variant="subtitle1" component="h3" sx={{ flexGrow: 1, fontWeight: 700 }}>{t.title}</Typography>
        <Tooltip title={copied ? 'Copied' : 'Copy summary'}><IconButton size="small" aria-label="Copy summary" onClick={copy}>{copied ? <CheckIcon fontSize="small" /> : <CopyIcon fontSize="small" />}</IconButton></Tooltip>
      </Stack>
      <Box sx={{ px: 2, pb: 1.75 }}>
        <Markdown>{c.summary}</Markdown>
        {c.needs && <Alert severity={c.status === 'blocked' ? 'error' : 'warning'} icon={<HelpIcon fontSize="inherit" />} sx={{ mt: 1.5 }} data-testid="conclusion-needs"><AlertTitle sx={{ mb: 0 }}>I need from you</AlertTitle><Markdown>{c.needs}</Markdown></Alert>}
        {files.length > 0 && (
          <Section title={`${files.length} file${files.length === 1 ? '' : 's'}`}>
            <Stack direction="row" sx={{ flexWrap: "wrap", gap: 0.5 }} data-testid="conclusion-files">
              {shown.map((f) => <Chip key={f} size="small" variant="outlined" label={f} onClick={onOpenFile ? () => onOpenFile(f) : undefined} aria-label={onOpenFile ? `Open ${f}` : undefined} sx={{ fontFamily: 'monospace', maxWidth: '100%' }} />)}
              {files.length > FILE_LIMIT && <Chip size="small" label={all ? 'Show fewer' : `Show ${files.length - FILE_LIMIT} more`} onClick={() => setAll(!all)} />}
            </Stack>
          </Section>)}
        {c.verification && <Section title="How I checked"><Stack direction="row" spacing={0.75} alignItems="flex-start"><CheckIcon fontSize="small" color="action" sx={{ mt: '3px' }} /><Box sx={{ minWidth: 0 }}><Markdown>{c.verification}</Markdown></Box></Stack></Section>}
        {c.next_steps?.length > 0 && (
          <Section title="What's next">
            <Stack direction="row" sx={{ flexWrap: "wrap", gap: 0.75 }} data-testid="conclusion-next">
              {c.next_steps.map((n) => <Chip key={n} color="primary" variant="outlined" label={<Markdown inline>{n}</Markdown>} onClick={onFollowUp ? () => onFollowUp(n) : undefined} aria-label={onFollowUp ? `Use as your next message: ${n}` : undefined} sx={{ height: 'auto', '& .MuiChip-label': { whiteSpace: 'normal', py: 0.5 } }} />)}
            </Stack>
            {onFollowUp && <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>Click one to put it in the message box.</Typography>}
          </Section>)}
      </Box>
    </Paper>
  );
}

export function PlanCard({ item, canAct, busy, onApprove }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderColor: 'primary.main' }} data-testid="plan-card">
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <Typography variant="subtitle2">{item.state === 'writing' ? 'Writing plan…' : 'Proposed plan'}</Typography>
        {item.state === 'writing' && <CircularProgress size={12} />}
      </Stack>
      <Markdown>{item.plan}</Markdown>
      {item.state !== 'writing' && <Button sx={{ mt: 1 }} size="small" variant="contained" disabled={busy || !canAct || item.state === 'approved'} onClick={onApprove}>{item.state === 'approved' ? 'Approved' : 'Approve & switch to Act'}</Button>}
    </Paper>
  );
}

// The agent asks to move to Act mode; nothing happens until the user confirms.
export function ModeRequestCard({ item, busy, onConfirm, onDecline }) {
  return (
    <Paper variant="outlined" data-testid="mode-request" sx={{ p: 1.5, borderColor: 'warning.main' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}><SwapIcon fontSize="small" color="warning" /><Typography variant="subtitle2">The agent recommends switching to Act mode</Typography></Stack>
      {item.reason && <Typography variant="body2" sx={{ mb: 1 }}>{item.reason}</Typography>}
      {item.state === 'pending'
        ? <Stack direction="row" spacing={1}><Button size="small" variant="contained" disabled={busy} onClick={onConfirm}>Switch to Act &amp; start</Button><Button size="small" disabled={busy} onClick={onDecline}>Not now</Button></Stack>
        : <Chip size="small" label={item.state === 'confirmed' ? 'Switched to Act mode' : 'Declined'} color={item.state === 'confirmed' ? 'success' : 'default'} />}
    </Paper>
  );
}

export const ModeChangedNote = ({ item }) => (
  <Paper variant="outlined" data-testid="mode-changed" sx={{ p: 1.25, borderColor: 'info.main' }}>
    <Stack direction="row" spacing={1} alignItems="center"><SwapIcon fontSize="small" color="info" /><Typography variant="subtitle2">The agent switched back to Plan mode (read-only)</Typography></Stack>
    {item.reason && <Typography variant="body2" sx={{ mt: 0.5 }}>{item.reason}</Typography>}
  </Paper>
);

// Marks the point where earlier messages left the agent's context. The summary is kept so the user can see what carried over.
export function CompactedCard({ item }) {
  const [open, setOpen] = useState(false);
  return (
    <Paper variant="outlined" data-testid="compacted" sx={{ borderStyle: 'dashed' }}>
      <ButtonBase onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Context compacted" sx={{ width: '100%', justifyContent: 'flex-start', gap: 1, px: 1.25, py: 0.75, textAlign: 'left' }}>
        <CompressIcon fontSize="small" color="action" />
        <Typography variant="body2" sx={{ flexGrow: 1 }}>Context compacted: {item.archived} earlier message{item.archived === 1 ? '' : 's'} summarized</Typography>
        <ExpandMoreIcon fontSize="small" sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </ButtonBase>
      <Collapse in={open} unmountOnExit><Box sx={{ px: 1.5, py: 1, borderTop: 1, borderColor: 'divider', bgcolor: 'action.hover' }}><Typography variant="caption" color="text.secondary">What the agent remembers</Typography><Markdown>{item.summary}</Markdown></Box></Collapse>
    </Paper>
  );
}
export const ClearedNote = ({ item }) => (
  <Paper variant="outlined" data-testid="cleared" sx={{ borderStyle: 'dashed', px: 1.25, py: 0.75 }}>
    <Stack direction="row" spacing={1} alignItems="center"><CompressIcon fontSize="small" color="action" /><Typography variant="body2">Context cleared{item.archived ? `: ${item.archived} earlier message${item.archived === 1 ? '' : 's'} no longer in the agent's memory` : ''}</Typography></Stack>
  </Paper>
);
export const CompactingNote = () => (
  <Paper variant="outlined" data-testid="compacting" sx={{ borderStyle: 'dashed', px: 1.25, py: 0.75 }}>
    <Stack direction="row" spacing={1} alignItems="center"><CircularProgress size={14} /><Typography variant="body2">Summarizing the session…</Typography></Stack>
  </Paper>
);

// Shown after Stop (and after reloading a session that was stopped): the agent's work so far is kept, so it can carry on.
export const StoppedCard = ({ onResume, onDismiss, disabled }) => (
  <Paper variant="outlined" data-testid="stopped" sx={{ borderStyle: 'dashed', px: 1.25, py: 0.75 }}>
    <Stack direction="row" spacing={1} alignItems="center">
      <StopCircleIcon fontSize="small" color="action" />
      <Typography variant="body2" sx={{ flexGrow: 1 }}>Stopped. The agent keeps everything it has done so far.</Typography>
      <Button size="small" variant="contained" startIcon={<PlayArrowIcon />} disabled={disabled} onClick={onResume}>Resume</Button>
      <Button size="small" onClick={onDismiss}>Dismiss</Button>
    </Stack>
  </Paper>
);

// ---- /status
const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const when = (t) => (t ? new Date(t * 1000).toLocaleString() : '—');
function Row({ k, children }) { return <Stack direction="row" spacing={1}><Typography variant="body2" color="text.secondary" sx={{ minWidth: 120 }}>{k}</Typography><Typography variant="body2" sx={{ wordBreak: 'break-word' }} component="div">{children}</Typography></Stack>; }

// Connection, server, user, and project at a glance (the reply to /status).
export function StatusCard({ s }) {
  const c = s.connection, m = c.model;
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }} data-testid="status-card">
      <Typography variant="subtitle2" gutterBottom>Status</Typography>
      <Stack spacing={1.25}>
        <div><Typography variant="caption" color="text.secondary">CONNECTION</Typography>
          <Row k="Status"><Chip size="small" color="success" label="Connected" /> signed in via {c.signedInVia}{c.mfaVerified ? ', MFA verified' : ''}</Row>
          <Row k="Session">started {when(c.sessionStartedAt)}; expires {when(c.sessionExpiresAt)} if idle</Row>
          <Row k="Model server">{m ? <>{m.provider} ({m.type}) · {m.model} {m.reachable === true ? <Chip size="small" color="success" variant="outlined" label="reachable" /> : m.reachable === false ? <Chip size="small" color="error" variant="outlined" label="not reachable" /> : null}</> : 'No model selected'}</Row></div>
        <div><Typography variant="caption" color="text.secondary">SERVER</Typography>
          <Row k="Connected to">{s.server.name} — {s.server.url}{s.server.secure ? '' : ' (not https)'}</Row>
          <Row k="Agent shell">{s.server.shell}</Row></div>
        <div><Typography variant="caption" color="text.secondary">USER</Typography>
          <Row k="Name">{s.user.displayName}{s.user.username && s.user.username !== s.user.displayName ? ` (${s.user.username})` : ''}</Row>
          {s.user.email && <Row k="Email">{s.user.email}</Row>}
          <Row k="Roles">{s.user.roles.join(', ') || 'none'}</Row></div>
        <div><Typography variant="caption" color="text.secondary">PROJECT</Typography>
          {s.project ? (<>
            <Row k="Name">{s.project.name}</Row>
            <Row k="Files">{s.project.files}{s.project.filesCapped ? '+' : ''} files · {bytes(s.project.sizeBytes)}</Row>
            <Row k="Git">{s.project.gitBranch ? `branch ${s.project.gitBranch}` : 'not a git repository'}</Row>
            <Row k="Checkpoints">{s.project.checkpoints}</Row></>) : <Row k="Project">none (this chat has no project access)</Row>}</div>
        <div><Typography variant="caption" color="text.secondary">FEATURES</Typography>
          <Row k="MCP servers">{s.features.mcpServers} active</Row>
          <Row k="Memory">{s.features.memory.length ? s.features.memory.join(' + ') : 'off'}</Row></div>
      </Stack>
    </Paper>
  );
}

export function MemorySavedNote({ item }) {
  return <Chip size="small" variant="outlined" color="info" label={`Remembered (${item.scope}): ${item.text}`} sx={{ alignSelf: 'flex-start', ml: 2, maxWidth: '95%', height: 'auto', '& .MuiChip-label': { whiteSpace: 'normal', py: 0.25 } }} data-testid="memory-saved" />;
}
