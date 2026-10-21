import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Alert, Box, Button, Link, List, ListItem, ListItemText, Paper, Stack, Tab, Tabs, TextField, Typography } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import { api, get, put, streamPost } from '../../api.js';
import Markdown from '../../components/Markdown.jsx';
import ThinkingBlock from '../../components/ThinkingBlock.jsx';
import { langOf } from '../../components/ide/EditorPane.jsx';
import { useColorMode } from '../../colorMode.jsx';

const TOOL_LABEL = { read_file: 'Read the file', write_file: 'Rewrote the file', edit_file: 'Edited the file', replace_lines: 'Edited lines', insert_lines: 'Inserted lines', delete_lines: 'Deleted lines', list_dir: 'Looked at the file', get_file_metadata: 'Checked the file', search: 'Searched the file', conclude: 'Summarized' };

// The chat inside a course page. History belongs to the learner and the page; "New conversation" clears it.
export function ChatPanel({ courseId, page, label = 'Ask a question', extraBody, onEvent, intro = 'Ask anything about this page.' }) {
  const base = `/api/courses/${courseId}/pages/${page.id}`;
  const [msgs, setMsgs] = useState([]); const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const ctl = useRef(null); const end = useRef(null);
  useEffect(() => { setMsgs([]); get(`${base}/conversation`).then((r) => setMsgs(r.messages)).catch(() => {}); return () => ctl.current?.abort(); }, [base]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }); }, [msgs]);
  const send = async () => {
    const message = text.trim(); if (!message || busy) return;
    setText(''); setErr(''); setBusy(true);
    setMsgs((m) => [...m, { role: 'user', content: message }, { role: 'assistant', content: '' }]);
    ctl.current = new AbortController();
    try {
      await streamPost(`${base}/turn`, { message, ...extraBody?.() }, (ev) => {
        onEvent?.(ev);
        if (ev.type === 'text') setMsgs((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], content: c[c.length - 1].content + ev.text }; return c; });
        if (ev.type === 'thinking') setMsgs((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], thinking: (c[c.length - 1].thinking || '') + ev.text }; return c; });
        if (ev.type === 'tool_start') setMsgs((m) => { const c = [...m]; c[c.length - 1] = { ...c[c.length - 1], steps: [...(c[c.length - 1].steps || []), TOOL_LABEL[ev.name] || ev.name] }; return c; });
        if (ev.type === 'error') setErr(ev.message);
      }, ctl.current.signal);
    } catch (e) {
      if (e.name !== 'AbortError') setErr({ no_model_available: 'No AI model is available. Ask an administrator to set one up.', conversation_limit: 'This conversation is full. Start a new one.' }[e.body?.error] || 'The request failed.');
    } finally { setBusy(false); setMsgs((m) => (m.at(-1)?.role === 'assistant' && !m.at(-1).content ? m.slice(0, -1) : m)); }
  };
  const reset = async () => { ctl.current?.abort(); await api('DELETE', `${base}/conversation`); setMsgs([]); setErr(''); };
  return (
    <Stack spacing={1} sx={{ height: '100%', minHeight: 320 }}>
      <Box role="log" aria-live="polite" aria-label="Conversation" sx={{ flexGrow: 1, overflow: 'auto', minHeight: 160 }}>
        {!msgs.length && <Typography color="text.secondary" variant="body2">{intro}</Typography>}
        {msgs.map((m, i) => (
          <Paper key={i} variant="outlined" sx={{ p: 1, mb: 1, ml: m.role === 'user' ? 4 : 0, mr: m.role === 'user' ? 0 : 4, bgcolor: m.role === 'user' ? 'action.hover' : 'background.paper' }}>
            <Typography variant="caption" color="text.secondary">{m.role === 'user' ? 'You' : 'Tutor'}</Typography>
            {m.role === 'assistant' && <ThinkingBlock text={m.thinking} live={busy && i === msgs.length - 1 && !m.content} />}
            {m.steps?.length > 0 && <Typography variant="caption" color="text.secondary" component="div">{m.steps.join(' · ')}</Typography>}
            {m.role === 'user' ? <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.content}</Typography> : <Markdown>{m.content}</Markdown>}
          </Paper>
        ))}
        <div ref={end} />
      </Box>
      {err && <Alert severity="error" onClose={() => setErr('')}>{err}</Alert>}
      <Stack direction="row" spacing={1}>
        <TextField fullWidth multiline maxRows={5} size="small" label={label} value={text} disabled={busy} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} slotProps={{ htmlInput: { maxLength: 4000 } }} />
        <Button variant="contained" onClick={send} disabled={busy || !text.trim()} aria-label="Send" endIcon={<SendIcon />}>Send</Button>
      </Stack>
      <Box><Button size="small" onClick={reset} disabled={!msgs.length}>New conversation</Button></Box>
    </Stack>
  );
}

function Notes({ courseId, page }) {
  const url = `/api/courses/${courseId}/pages/${page.id}/notes`;
  const [text, setText] = useState(''); const [state, setState] = useState('');
  useEffect(() => { get(url).then((r) => setText(r.text)).catch(() => {}); }, [url]);
  const save = async () => { try { await put(url, { text }); setState('Saved'); } catch { setState('Could not save'); } };
  return (
    <Stack spacing={1}>
      <TextField multiline minRows={6} label="Your private notes for this page" value={text} onChange={(e) => { setText(e.target.value); setState(''); }} slotProps={{ htmlInput: { maxLength: 20000 } }} />
      <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}><Button variant="outlined" onClick={save}>Save notes</Button><Typography role="status" variant="body2">{state}</Typography></Stack>
    </Stack>
  );
}

function Hints({ hints = [] }) {
  const [shown, setShown] = useState(0);
  if (!hints.length) return <Typography color="text.secondary">No hints for this page.</Typography>;
  return (
    <Stack spacing={1}>
      <List dense disablePadding>{hints.slice(0, shown).map((h, i) => <ListItem key={i} disableGutters><ListItemText primary={`${i + 1}. ${h}`} /></ListItem>)}</List>
      <Box><Button variant="outlined" disabled={shown >= hints.length} onClick={() => setShown(shown + 1)}>{shown ? 'Show another hint' : 'Show a hint'}</Button></Box>
      <Typography variant="caption" color="text.secondary">{shown} of {hints.length} hints shown</Typography>
    </Stack>
  );
}

function Resources({ links = [] }) {
  if (!links.length) return <Typography color="text.secondary">No resources for this page.</Typography>;
  return <List dense disablePadding>{links.map((l, i) => <ListItem key={i} disableGutters><Link href={l.url} target="_blank" rel="noopener noreferrer">{l.title}</Link></ListItem>)}</List>;
}

function Progress({ course }) {
  const done = new Set(course.completed);
  return (
    <Box>
      <Typography gutterBottom>{done.size} of {course.pages.length} pages complete</Typography>
      <List dense disablePadding>{course.pages.map((p) => <ListItem key={p.id} disableGutters><ListItemText primary={`${done.has(p.id) ? '✓' : '○'} ${p.title}`} /></ListItem>)}</List>
    </Box>
  );
}

// The tutor agent panel: the chat, plus the subpanels the instructor turned on for this page (from the administrator's catalog).
export function TutorPanel({ course, page }) {
  const catalog = new Map((course.subpanels || []).map((s) => [s.id, s]));
  const subs = (page.config.subpanels || []).map((id) => catalog.get(id)).filter(Boolean);
  const [tab, setTab] = useState('tutor');
  useEffect(() => { setTab('tutor'); }, [page.id]);
  const content = (id) => page.config.subpanelContent?.[id] || {};
  const body = { notes: () => <Notes courseId={course.id} page={page} />, hints: (s) => <Hints hints={content(s.id).hints} />, resources: (s) => <Resources links={content(s.id).links} />, progress: () => <Progress course={course} /> };
  const active = subs.find((s) => s.id === tab);
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" aria-label="Tutor panels" sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tab value="tutor" label="Tutor" />{subs.map((s) => <Tab key={s.id} value={s.id} label={s.label} />)}
      </Tabs>
      <Box sx={{ p: 2, flexGrow: 1, minHeight: 0 }}>{active ? body[active.type](active) : <ChatPanel courseId={course.id} page={page} />}</Box>
    </Box>
  );
}

// The 'editor with agent' layout: a Monaco editor holding the learner's copy of one file (the instructor's text to start with),
// and the agent chat beneath it, which can read and edit that file and nothing else.
export function FilePanel({ course, page }) {
  const url = `/api/courses/${course.id}/pages/${page.id}/file`;
  const { mode } = useColorMode();
  const [file, setFile] = useState(null); const [value, setValue] = useState(''); const [state, setState] = useState('');
  const latest = useRef(''); const timer = useRef(null); const dirty = useRef(false);
  const flush = async () => {
    clearTimeout(timer.current); if (!dirty.current) return; dirty.current = false;
    try { await put(url, { content: latest.current }); setState('Saved'); } catch { dirty.current = true; setState('Could not save'); }
  };
  useEffect(() => {
    setFile(null); setState('');
    get(url).then((f) => { setFile(f); setValue(f.content); latest.current = f.content; }).catch(() => setState('Could not load the file'));
    return () => { clearTimeout(timer.current); if (dirty.current) put(url, { content: latest.current }).catch(() => {}); dirty.current = false; };
  }, [url]);
  const edit = (v = '') => { setValue(v); latest.current = v; dirty.current = true; setState(''); clearTimeout(timer.current); timer.current = setTimeout(flush, 800); };
  const reset = async () => { if (!window.confirm('Replace your file with the starting version?')) return; clearTimeout(timer.current); dirty.current = false; const f = await api('DELETE', url); setFile(f); setValue(f.content); latest.current = f.content; setState('Reset'); };
  if (!file) return <Typography color="text.secondary" role="status">{state || 'Loading the file…'}</Typography>;
  return (
    <Stack spacing={1} sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="subtitle2" component="h3" sx={{ flexGrow: 1, fontFamily: 'monospace' }}>{file.name}</Typography>
        <Typography role="status" variant="caption" color="text.secondary">{state}</Typography>
        <Button size="small" onClick={reset}>Reset to starting version</Button>
      </Stack>
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }} aria-label={`Editor for ${file.name}`}>
        <Editor height="360px" path={`course-${course.id}-page-${page.id}/${file.name}`} language={langOf(file.name)} value={value} onChange={edit} theme={mode === 'dark' ? 'vs-dark' : 'light'}
          options={{ minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, fontSize: 14, wordWrap: 'on' }} />
      </Box>
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }}>
        <ChatPanel courseId={course.id} page={page} label="Ask the assistant to change the file" intro="Ask the assistant to help with the file above. It can read and edit that file."
          extraBody={() => { clearTimeout(timer.current); dirty.current = false; return { content: latest.current }; }}
          onEvent={(ev) => { if (ev.type === 'file') { setValue(ev.content); latest.current = ev.content; dirty.current = false; } }} />
      </Box>
    </Stack>
  );
}
