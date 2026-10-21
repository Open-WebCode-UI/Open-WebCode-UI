import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../AuthContext.jsx';
import { PromptDialog } from '../components/ProjectDialogs.jsx';
import { RowCheckbox, SelectionBar, useSelection } from '../components/ListManage.jsx';
import MessageInput from '../components/MessageInput.jsx';
import { Box, Chip, CircularProgress, FormControl, InputLabel, Paper, Select, Stack, IconButton, Typography, Alert, Button, List, ListItemButton, ListItemText, Menu, MenuItem, Tab, Tabs, Tooltip } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import SendIcon from '@mui/icons-material/Send';
import StopIcon from '@mui/icons-material/Stop';
import { get, post, put, del, streamPost } from '../api.js';
import Markdown from '../components/Markdown.jsx';
import ThinkingBlock from '../components/ThinkingBlock.jsx';
import SkillsMenu from '../components/SkillsMenu.jsx';
import { lastModel, rememberModel, pickModel, thinkingPref, rememberThinking, effortPref, rememberEffort } from '../modelPref.js';
import ContactFooter from '../components/ContactFooter.jsx';
import AiDisclaimer from '../components/AiDisclaimer.jsx';
import CopyButton from '../components/CopyButton.jsx';
import ModelPicker from '../components/ModelPicker.jsx';
import WebSearchToggle from '../components/WebSearchToggle.jsx';
import { StatusCard, StoppedCard, MediaList } from '../components/AgentItems.jsx';
import TurnStatus from '../components/TurnStatus.jsx';
import { useAttachments, AttachButton, AttachmentChips, SentAttachments } from '../components/Attachments.jsx';

const money = (n) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const fmtTokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);

const TABS = {
  general: { label: 'General', perm: 'chat.general.use', title: 'General assistant', placeholder: 'Ask anything… (or /skill-name)' },
  coding: { label: 'Coding', perm: 'chat.use', title: 'Coding assistant', placeholder: 'Ask anything about code… (or /skill-name)' },
  course: { label: 'Course Design', perm: 'chat.course.use', also: 'course.author', title: 'Course design assistant', placeholder: 'Describe what to write or change in the course… (or /skill-name)' },
};
const COURSE_WRITES = new Set(['create_page', 'update_page', 'create_module', 'update_module', 'create_assessment', 'update_assessment', 'delete_assessment', 'create_question', 'update_question', 'delete_question']), COURSE_TOOLS = new Set([...COURSE_WRITES, 'get_course', 'read_page', 'read_assessment']);
// What the assistant is doing to the course right now, shown while a tool call is being written or run (a page body can take a while).
const activityLabel = (a) => {
  if (a.name === 'get_course') return 'Reading the course outline…';
  if (a.name === 'read_page') return 'Reading a page…';
  if (a.name === 'create_module') return 'Creating a module…';
  if (a.name === 'update_module') return 'Renaming a module…';
  if (a.name === 'create_assessment') return 'Creating an assessment…';
  if (a.name === 'update_assessment') return 'Updating an assessment…';
  if (a.name === 'delete_assessment') return 'Deleting an assessment…';
  if (a.name === 'read_assessment') return 'Reading an assessment…';
  if (a.name === 'create_question') return 'Writing a question…';
  if (a.name === 'update_question') return 'Updating a question…';
  if (a.name === 'delete_question') return 'Removing a question…';
  const page = a.title ? `“${a.title}”` : a.pageId ? `page ${a.pageId}` : 'a page';
  const size = a.chars ? ` (${a.chars.toLocaleString()} characters)` : '';
  return `${a.name === 'create_page' ? 'Writing' : 'Updating'} ${page}${size}…`;
};
// The live line for a course tool call, with the page text as it is written. Open by default so the draft can be followed; it can be collapsed.
function CourseActivity({ a }) {
  const [open, setOpen] = useState(true); const box = useRef(null);
  useEffect(() => { if (open && box.current) box.current.scrollTop = box.current.scrollHeight; }, [a.text, open]);
  return (
    <Box sx={{ my: 1, border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }} data-testid="course-activity" role="status">
      <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 1.25, py: 0.5, color: 'text.secondary' }}>
        <CircularProgress size={14} /><Typography variant="caption" sx={{ flexGrow: 1 }}>{activityLabel(a)}</Typography>
        {a.text && <Button size="small" onClick={() => setOpen(!open)} aria-expanded={open} sx={{ textTransform: 'none', minWidth: 0 }}>{open ? 'Hide preview' : 'Show preview'}</Button>}
      </Stack>
      {a.text && open && <Box ref={box} data-testid="course-preview" sx={{ px: 1.5, py: 1, maxHeight: 240, overflow: 'auto', borderTop: 1, borderColor: 'divider', bgcolor: 'action.hover' }}><Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace' }}>{a.text}</Typography></Box>}
    </Box>
  );
}
const setActivity = (m, id, name, patch) => { const c = [...m], l = c.at(-1), cur = l.activity?.id === id ? l.activity : { id, name, title: '', chars: 0, text: '' }; c[c.length - 1] = { ...l, activity: patch(cur) }; return c; };

// The chat page: a General tab, a Coding tab, and a Course Design tab (for instructors, working on one of their courses). Each has its own chats, system prompt, and permissions (use, web search, memory).
// Both stay mounted, so a reply that is still streaming in one tab keeps arriving while you look at the other.
export default function Chat() {
  const { can } = useAuth();
  const tabs = Object.keys(TABS).filter((t) => can(TABS[t].perm) && (!TABS[t].also || can(TABS[t].also)));
  const [tab, setTab] = useState(() => { try { const v = localStorage.getItem('chatTab'); return TABS[v] ? v : null; } catch { return null; } });
  const current = tabs.includes(tab) ? tab : tabs[0];
  const choose = (t) => { setTab(t); try { localStorage.setItem('chatTab', t); } catch { /* storage may be unavailable */ } };
  if (!current) return null;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {tabs.length > 1 && <Tabs value={current} onChange={(_, v) => choose(v)} aria-label="Chat type" sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 40 }}>{tabs.map((t) => <Tab key={t} value={t} label={TABS[t].label} sx={{ minHeight: 40 }} />)}</Tabs>}
      <Box sx={{ flexGrow: 1, minHeight: 0 }}>{tabs.map((t) => <ChatTab key={t} type={t} active={t === current} />)}</Box>
    </Box>
  );
}

// One tab's assistant: its own system prompt, no project access, and no tools (except web search, when it is switched on for the chat).
// Course Design is the exception: its chats belong to one course the user teaches, and the assistant can read and write that course's pages.
function ChatTab({ type, active }) {
  const { can } = useAuth();
  const T = TABS[type], canSearch = can(`chat.${type}.websearch`);
  const [menu, setMenu] = useState(null); const [rename, setRename] = useState(null); const [listErr, setListErr] = useState('');
  const [models, setModels] = useState([]); const [defaultId, setDefaultId] = useState(null); const [picked, setPicked] = useState(null);
  const [convs, setConvs] = useState([]); const [convId, setConvId] = useState(null);
  const [msgs, setMsgs] = useState([]); const [input, setInput] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const [thinking, setThinking] = useState(thinkingPref); const [effort, setEffort] = useState(effortPref); const [webSearch, setWebSearch] = useState(false); const [note, setNote] = useState('');
  const att = useAttachments(); const [phase, setPhase] = useState(null);
  const isCourse = type === 'course'; const [courses, setCourses] = useState([]); const [courseId, setCourseId] = useState('');
  const endRef = useRef(null); const ctlRef = useRef(null); const [stopped, setStopped] = useState(false);
  useEffect(() => () => ctlRef.current?.abort(), []);
  // What the open chat last used, else the last model picked, else the admin default.
  const modelId = pickModel(models, picked, lastModel('chat'), defaultId);
  const model = models.find((m) => m.id === modelId);
  const chooseModel = (id) => { setPicked(id); rememberModel('chat', id); };
  const loadConvs = () => get(`/api/conversations?kind=chat&chatType=${type}`).then(setConvs).catch(() => {});
  useEffect(() => { if (isCourse) get('/api/courses/authored').then((r) => { setCourses(r); setCourseId((cur) => cur || r[0]?.id || ''); }).catch(() => {}); }, [isCourse]);
  useEffect(() => { get('/api/models').then((r) => { setModels(r.models); setDefaultId(r.defaults?.chat ?? null); }).catch(() => {}); loadConvs(); }, []);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [msgs]);
  // A blank chat that was left for a saved one stays open (with its draft) until it is used, so New chat returns to it instead of making another.
  const [parked, setParked] = useState(null);
  const openConv = async (id) => { if (convId === null && id !== convId) { setParked({ input, webSearch, picked }); setInput(''); } setConvId(id); setPicked(convs.find((c) => c.id === id)?.modelId ?? null); if (isCourse) setCourseId(convs.find((c) => c.id === id)?.courseId ?? ''); setWebSearch(!!convs.find((c) => c.id === id)?.webSearch); setMsgs((await get(`/api/conversations/${id}/messages`)).map((m) => ({ role: m.role, text: m.content, thinking: m.thinking, ...(m.role === 'assistant' ? { media: m.attachments } : { attachments: m.attachments }) }))); };

  // From sending a message until the model starts to answer (reading the prompt, or loading): say what is happening, with a timer.
  const blank = convId === null && !msgs.length && !busy && !err && !note;
  const last = msgs.at(-1), noReplyYet = last?.role === 'assistant' && !last.text && !last.thinking;
  const waiting = busy && noReplyYet && (phase?.name === 'prefill' || phase?.name === 'sending');
  const selection = useSelection(convs.map((c) => c.id));
  const newChat = () => {
    if (convId === null) return; // the blank chat is already open
    setMsgs([]); setErr(''); setNote(''); setStopped(false); setConvId(null);
    setWebSearch(parked?.webSearch ?? false); setPicked(parked?.picked ?? null); setInput(parked?.input ?? ''); setParked(null);
  };
  const afterDelete = (ids) => { if (ids.includes(convId)) newChat(); loadConvs(); };
  const removeOne = async (c) => { setMenu(null); if (!window.confirm(`Delete the chat “${c.title}”? This cannot be undone.`)) return; try { await del(`/api/conversations/${c.id}`); setListErr(''); afterDelete([c.id]); } catch { setListErr('Could not delete the chat.'); } };
  const removeMany = async (opts) => { const r = await post('/api/conversations/bulk-delete', { chatType: type, ...(opts.all ? { all: true } : { ids: opts.ids }) }); setListErr(''); afterDelete(r.deletedIds); };
  const RESUME_TEXT = 'You were interrupted. Continue from where you left off, without repeating work that is already done.';
  const send = async (override) => {
    const text = typeof override === 'string' ? override : input;
    if (!text.trim() || busy || (isCourse && !courseId)) return;
    const files = typeof override === 'string' ? [] : att.items; if (typeof override !== 'string') setInput(''); setErr(''); setNote(''); setStopped(false); setBusy(true); att.clear();
    const ctl = new AbortController(); ctlRef.current = ctl; setPhase({ name: 'sending', since: Date.now() });
    setMsgs((m) => [...m, { role: 'user', text, attachments: files.map((a) => ({ name: a.name, kind: a.kind })) }, { role: 'assistant', text: '' }]);
    try {
      await streamPost('/api/chat/turn', { chatType: type, ...(isCourse ? { courseId } : {}), message: text, conversationId: convId ?? undefined, modelId: modelId || undefined, thinking: !!model?.supportsThinking && thinking, effort, webSearch: canSearch && webSearch, attachments: files.length ? files.map((a) => a.id) : undefined }, (ev) => {
       
        if (ev.type === 'phase') setPhase(ev.phase === 'prefill' ? { name: 'prefill', since: Date.now(), tokens: ev.tokens, etaMs: ev.etaMs } : { name: ev.phase });
        if (ev.type === 'start') { setConvId(ev.conversationId); setPicked(modelId || null); }
        if (ev.type === 'text') setMsgs((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], text: c[c.length - 1].text + ev.text }; return c; });
        if (ev.type === 'thinking') setMsgs((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], thinking: (c[c.length - 1].thinking || '') + ev.text }; return c; });
        if (ev.type === 'media') setMsgs((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], media: [...(c[c.length - 1].media || []), ...ev.attachments] }; return c; });
        if (ev.type === 'status') setMsgs((m) => [...m.slice(0, -1), { role: 'status', status: ev }]);
        if (ev.type === 'notice') setNote(ev.text);
        if (ev.type === 'tool_progress' && COURSE_TOOLS.has(ev.name)) setMsgs((m) => setActivity(m, ev.id, ev.name, (a) => ({ ...a, title: a.title + (ev.fields.title || ''), pageId: (a.pageId || '') + (ev.fields.page_id || ''), chars: a.chars + (ev.fields.markdown?.length || 0), text: a.text + (ev.fields.markdown || '') })));
        if (ev.type === 'tool_start' && COURSE_TOOLS.has(ev.name)) setMsgs((m) => setActivity(m, ev.id, ev.name, (a) => ({ ...a, title: a.title || ev.args?.title || '', pageId: a.pageId || ev.args?.page_id || '', chars: Math.max(a.chars, ev.args?.markdown?.length || 0), text: a.text || ev.args?.markdown || '' })));
        if (ev.type === 'tool_result' && COURSE_TOOLS.has(ev.name)) setMsgs((m) => { const c = [...m]; const l = c.at(-1); c[c.length - 1] = { ...l, activity: l.activity?.id === ev.id ? undefined : l.activity, ...(COURSE_WRITES.has(ev.name) ? { edits: [...(l.edits || []), { text: String(ev.result).split('\n')[0], error: /^Error/.test(ev.result) }] } : {}) }; return c; });
        if (ev.type === 'tool_start' && ev.name === 'web_search') setMsgs((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], searches: [...(c[c.length - 1].searches || []), ev.args?.query] }; return c; });
        if (ev.type === 'error' && !ctl.signal.aborted) setErr(ev.message);
      }, ctl.signal);
    } catch (e) { if (e.name === 'AbortError') { setStopped(true); setMsgs((m) => (m.at(-1)?.role === 'assistant' && !m.at(-1).text && !m.at(-1).thinking && !m.at(-1).media?.length ? m.slice(0, -1) : m)); } else setErr(e.body?.error === 'no_model_available' ? 'No AI model is available. Ask an administrator to configure one.' : 'Request failed'); }
    finally { ctlRef.current = null; setBusy(false); setPhase(null); loadConvs(); }
  };

  return (
    <Box role="tabpanel" hidden={!active} aria-label={`${T.label} chat`} sx={{ display: active ? 'grid' : 'none', gridTemplateColumns: '240px minmax(0,1fr)', gridTemplateRows: 'minmax(0,1fr)', height: '100%' }}>
      <Box sx={{ borderRight: 1, borderColor: 'divider', overflow: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Box sx={{ p: 1.5, pb: 0.5 }}>
          <Button fullWidth variant="contained" disableElevation startIcon={<AddIcon />} disabled={busy} onClick={newChat} sx={{ textTransform: 'none', fontWeight: 600, borderRadius: 2, py: 0.75 }}>New chat</Button>
        </Box>
        <SelectionBar selection={selection} ids={convs.map((c) => c.id)} noun="chat" onDelete={(ids) => removeMany({ ids })} onDeleteAll={() => removeMany({ all: true })} />
        {listErr && <Typography variant="caption" color="error" sx={{ px: 1.5 }} role="alert">{listErr}</Typography>}
        <List dense aria-label={`${T.label} chats`}>
          {(convId === null || parked) && <ListItemButton selected={convId === null} data-testid="chat-blank" onClick={newChat}><ListItemText primary="New chat" primaryTypographyProps={{ fontStyle: 'italic' }} secondary="Not saved until you send a message" secondaryTypographyProps={{ noWrap: true }} /></ListItemButton>}
          {convs.map((c) => (
          <ListItemButton key={c.id} selected={c.id === convId} disabled={busy && c.id !== convId} onClick={() => (selection.selecting ? selection.toggle(c.id) : openConv(c.id))} sx={{ pr: 5 }}>
            {selection.selecting && <RowCheckbox selection={selection} id={c.id} label={c.title} />}
            <ListItemText primary={c.title} primaryTypographyProps={{ noWrap: true }} secondary={c.cost != null ? <span data-testid="chat-usage">~{fmtTokens(c.tokens)} tokens · {money(c.cost)}</span> : null} secondaryTypographyProps={{ noWrap: true }} />
            {!selection.selecting && <Tooltip title="Chat options"><IconButton size="small" aria-label={`Options for ${c.title}`} sx={{ position: 'absolute', right: 4 }} onClick={(e) => { e.stopPropagation(); setMenu({ anchor: e.currentTarget, c }); }}><MoreVertIcon fontSize="inherit" /></IconButton></Tooltip>}
          </ListItemButton>))}
        </List>
        <Menu anchorEl={menu?.anchor} open={!!menu} onClose={() => setMenu(null)} slotProps={{ list: { dense: true, 'aria-label': 'Chat options' } }}>
          <MenuItem onClick={() => { setRename(menu.c); setMenu(null); }}>Rename…</MenuItem>
          <MenuItem onClick={() => removeOne(menu.c)}>Delete</MenuItem>
        </Menu>
        {rename && <PromptDialog title="Rename chat" label="Name" initial={rename.title} okLabel="Rename" onClose={() => setRename(null)} onOk={async (v) => { const c = rename; setRename(null); try { await put(`/api/conversations/${c.id}`, { title: v }); setListErr(''); } catch { setListErr('Could not rename the chat.'); } loadConvs(); }} />}
        <Box sx={{ mt: 'auto' }}><ContactFooter variant="stacked" /></Box>
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, maxWidth: 900, width: '100%', mx: 'auto' }}>
        <Stack direction="row" sx={{ p: 1.5 }} alignItems="center" spacing={1}>
          <Typography variant="subtitle1" sx={{ flexGrow: 1 }}>{T.title} <Typography component="span" variant="caption" color="text.secondary">{T.note}</Typography></Typography>
          {isCourse && <FormControl size="small" sx={{ minWidth: 200, maxWidth: 280 }}><InputLabel id="course-pick">Course</InputLabel>
            <Select labelId="course-pick" label="Course" value={courses.some((c) => c.id === courseId) ? courseId : ''} disabled={busy || convId !== null} onChange={(e) => setCourseId(e.target.value)}>
              {courses.map((c) => <MenuItem key={c.id} value={c.id}>{c.title}{c.status !== 'draft' ? ` (${c.status})` : ''}</MenuItem>)}
            </Select></FormControl>}
          <ModelPicker models={models} value={modelId} onChange={chooseModel} defaults={{ chat: defaultId }} kinds={['chat']} busy={busy}
            effort={effort} onEffort={(v) => { setEffort(v); rememberEffort(v); }} thinking={thinking} onThinking={(v) => { setThinking(v); rememberThinking(v); }}
            extra={canSearch ? <WebSearchToggle value={webSearch} disabled={busy} onChange={setWebSearch} /> : null} />
        </Stack>
        <Box sx={{ flexGrow: 1, overflow: 'auto', px: 2, ...(blank && { display: 'flex', flexDirection: 'column' }) }} aria-live="polite">
          {blank && <Typography color="text.secondary" sx={{ m: 'auto', fontStyle: 'italic', textAlign: 'center' }}>Type a message below to start a chat, or pick one from the list.</Typography>}
          {msgs.map((m, i) => (waiting && i === msgs.length - 1 ? null : m.role === 'status' ? <Box key={i} sx={{ mb: 1.5 }}><StatusCard s={m.status} /></Box> : <Paper key={i} variant="outlined" sx={{ p: 1.5, mb: 1.5, bgcolor: m.role === 'user' ? 'action.hover' : 'background.paper' }}><Stack direction="row" alignItems="center"><Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>{m.role === 'user' ? 'You' : 'Assistant'}</Typography><CopyButton text={m.text} label={m.role === 'user' ? 'Copy prompt' : 'Copy response'} /></Stack>{m.role === 'assistant' && <ThinkingBlock text={m.thinking} searches={m.searches} live={busy && i === msgs.length - 1 && !m.text} />}{m.activity && <CourseActivity a={m.activity} />}{m.edits?.length > 0 && <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ my: 1 }} data-testid="course-edits">{m.edits.map((e, k) => <Chip key={k} size="small" variant="outlined" color={e.error ? 'warning' : 'success'} label={e.text} sx={{ maxWidth: '100%' }} />)}</Stack>}{m.role === 'user' ? <><Typography sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</Typography><SentAttachments items={m.attachments} /></> : <><Markdown>{m.text}</Markdown>{m.media?.length > 0 && <MediaList items={m.media} />}</>}</Paper>))}
          {waiting && <Box sx={{ mb: 1.5 }}><TurnStatus phase={phase} who="Assistant" /></Box>}
          {note && <Alert severity="info" sx={{ mb: 1 }} onClose={() => setNote('')}>{note}</Alert>}
          {stopped && !busy && <Box sx={{ mb: 1.5 }}><StoppedCard onResume={() => send(RESUME_TEXT)} onDismiss={() => setStopped(false)} /></Box>}
          {isCourse && !courses.length && <Alert severity="info" sx={{ mb: 1 }}>You don’t teach any courses yet. Create one on the Courses page, then come back to design it here.</Alert>}
          {err && <Alert severity="error">{err}</Alert>}<div ref={endRef} />
        </Box>
        <AttachmentChips att={att} />
        <Stack direction="row" spacing={1} sx={{ p: 1.5, alignItems: 'flex-end' }}>
          <AttachButton model={model} att={att} disabled={busy} />
          <SkillsMenu scope="chat" disabled={busy} onPick={(s) => setInput((cur) => s + cur.replace(/^\/[a-z0-9-]*\s*/, ''))} />
          <MessageInput value={input} onChange={setInput} onSubmit={() => send()} maxRows={8} placeholder={T.placeholder} />
          {busy ? <IconButton aria-label="Stop" onClick={() => ctlRef.current?.abort()}><StopIcon /></IconButton>
            : <IconButton color="primary" aria-label="Send" disabled={!input.trim() || (isCourse && !courseId)} onClick={() => send()}><SendIcon /></IconButton>}
        </Stack>
        <AiDisclaimer />
      </Box>
    </Box>
  );
}
