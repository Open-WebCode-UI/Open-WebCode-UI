import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Card, IconButton, Stack, MenuItem, Select, Tooltip, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import DeleteOutlineIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import ClearAllIcon from '@mui/icons-material/ClearAll';
import FormatBoldIcon from '@mui/icons-material/FormatBold';
import FormatItalicIcon from '@mui/icons-material/FormatItalic';
import StrikethroughSIcon from '@mui/icons-material/StrikethroughS';
import CodeIcon from '@mui/icons-material/Code';
import TitleIcon from '@mui/icons-material/Title';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import FormatListNumberedIcon from '@mui/icons-material/FormatListNumbered';
import FormatQuoteIcon from '@mui/icons-material/FormatQuote';
import DataObjectIcon from '@mui/icons-material/DataObject';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import { get, post, streamPost } from '../../api.js';
import { useStepUp } from '../StepUp.jsx';
import Markdown from '../Markdown.jsx';
import { applyFormat } from './markdownFormat.js';
import { appendEvent, applyRun, cellKey, isPython, parseNotebook, serializeNotebook, sourceText, setSource, insertCell, deleteCell, moveCell, clearOutputs, setCellType, outputsOf } from './notebook.js';

const TOOLS = [
  ['Bold', FormatBoldIcon, 'bold'], ['Italic', FormatItalicIcon, 'italic'], ['Strikethrough', StrikethroughSIcon, 'strike'], ['Inline code', CodeIcon, 'code'],
  ['Heading', TitleIcon, 'heading'], ['Bulleted list', FormatListBulletedIcon, 'bullet'], ['Numbered list', FormatListNumberedIcon, 'numbered'],
  ['Quote', FormatQuoteIcon, 'quote'], ['Code block', DataObjectIcon, 'codeBlock'],
];

// Hover (or keyboard focus) the gap between two cells to insert a new cell there.
function Gap({ index, editable, onInsert }) {
  const add = (type, label) => <Button size="small" variant="outlined" aria-label={`Insert ${type} cell at position ${index + 1}`} disabled={!editable} onClick={() => onInsert(index, type)} sx={{ py: 0, minHeight: 22, textTransform: 'none', bgcolor: 'background.paper' }}>+ {label}</Button>;
  return (
    <Box data-testid="cell-gap" sx={{ position: 'relative', height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1,
      '&::before': { content: '""', position: 'absolute', left: 0, right: 0, top: '50%', borderTop: 1, borderColor: 'divider', opacity: 0 },
      '& > button': { opacity: 0, zIndex: 1 }, '&:hover::before, &:focus-within::before': { opacity: 1 }, '&:hover > button, &:focus-within > button': { opacity: 1 } }}>
      {add('code', 'Code')}{add('markdown', 'Markdown')}
    </Box>
  );
}

const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 13 };

// Rich HTML (pandas tables, ...) from a notebook is untrusted: it goes in a frame with no scripts, no network (CSP) and no top navigation.
const CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">';
function HtmlOutput({ html }) {
  const theme = useTheme();
  const doc = `${CSP}<style>body{margin:0;font:13px sans-serif;color:${theme.palette.text.primary}}table{border-collapse:collapse}td,th{border:1px solid ${theme.palette.divider};padding:2px 8px;text-align:right}th{font-weight:600}</style>${html}`;
  const fit = (e) => { try { e.target.style.height = `${e.target.contentDocument.documentElement.scrollHeight}px`; } catch { /* keep the default height */ } };
  return <Box component="iframe" title="HTML output" data-testid="html-output" sandbox="allow-same-origin" srcDoc={doc} onLoad={fit} sx={{ border: 0, width: '100%', height: 120, display: 'block', maxHeight: 600 }} />;
}

function Outputs({ cell, live }) {
  const outs = outputsOf(live ? { cell_type: 'code', outputs: live } : cell);
  if (!outs.length) return null;
  return (
    <Box data-testid="cell-outputs" sx={{ mt: 0.5, pl: 1, borderLeft: 3, borderColor: 'divider' }}>
      {outs.map((o, i) => o.kind === 'image'
        ? <Box key={i} component="img" src={o.src} alt="Cell output" sx={{ maxWidth: '100%', display: 'block', bgcolor: '#fff' }} />
        : o.kind === 'html' ? <HtmlOutput key={i} html={o.html} />
        : o.kind === 'markdown' ? <Box key={i} data-testid="markdown-output"><Markdown>{o.text}</Markdown></Box>
        : <Box key={i} component="pre" sx={{ ...mono, m: 0, py: 0.25, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: o.kind === 'error' || o.stream === 'stderr' ? 'error.main' : 'text.primary' }}>{o.text}</Box>)}
    </Box>
  );
}

function Cell({ cell, index, count, editable, onChange, runner }) {
  const [editing, setEditing] = useState(false);
  const src = sourceText(cell), type = cell.cell_type;
  const rendered = type === 'markdown' && !editing && src.trim();
  const label = `Cell ${index + 1}`;
  const ta = useRef(null), pendingSel = useRef(null);
  // After a format button rewrites the text, put the cursor/selection back once the new value is in the textarea.
  useLayoutEffect(() => { const sel = pendingSel.current; if (sel && ta.current) { pendingSel.current = null; ta.current.focus(); ta.current.setSelectionRange(sel.start, sel.end); } }, [src]);
  const format = (kind) => {
    const el = ta.current; if (!el) return;
    const r = applyFormat(el.value, el.selectionStart, el.selectionEnd, kind);
    pendingSel.current = r; onChange((nb) => setSource(nb, index, r.text));
  };
  const btn = (title, icon, fn, disabled) => <Tooltip title={title}><span><IconButton size="small" aria-label={`${title} ${index + 1}`} disabled={disabled || !editable} onClick={fn}>{icon}</IconButton></span></Tooltip>;
  return (
    <Box role="group" aria-label={label} data-testid="notebook-cell" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.default' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.25, borderBottom: 1, borderColor: 'divider' }}>
        {type === 'code' && runner.canRun && (runner.runningKey === cellKey(cell, index)
          ? <Tooltip title="Stop"><IconButton size="small" color="error" aria-label={`Stop cell ${index + 1}`} onClick={runner.stop}><StopIcon fontSize="inherit" /></IconButton></Tooltip>
          : <Tooltip title="Run cell"><span><IconButton size="small" aria-label={`Run cell ${index + 1}`} disabled={!editable || runner.runningKey !== null} onClick={() => runner.run(cellKey(cell, index))}><PlayArrowIcon fontSize="inherit" /></IconButton></span></Tooltip>)}
        <Typography variant="caption" color="text.secondary" sx={{ ...mono, minWidth: 48 }}>{type === 'code' ? (runner.runningKey === cellKey(cell, index) ? '[*]' : `[${cell.execution_count ?? ' '}]`) : ''}</Typography>
        <Select size="small" variant="standard" disableUnderline value={['code', 'markdown', 'raw'].includes(type) ? type : 'raw'} disabled={!editable} inputProps={{ 'aria-label': `Type of cell ${index + 1}` }}
          onChange={(e) => onChange((nb) => setCellType(nb, index, e.target.value))} sx={{ fontSize: 13 }}>
          <MenuItem value="code">Code</MenuItem><MenuItem value="markdown">Markdown</MenuItem><MenuItem value="raw">Raw</MenuItem>
        </Select>
        <Box sx={{ flexGrow: 1 }} />
        {type === 'code' && btn('Clear outputs of cell', <ClearAllIcon fontSize="inherit" />, () => onChange((nb) => clearOutputs(nb, index)), !cell.outputs?.length)}
        {btn('Move cell up', <ArrowUpwardIcon fontSize="inherit" />, () => onChange((nb) => moveCell(nb, index, -1)), index === 0)}
        {btn('Move cell down', <ArrowDownwardIcon fontSize="inherit" />, () => onChange((nb) => moveCell(nb, index, 1)), index === count - 1)}
        {btn('Delete cell', <DeleteOutlineIcon fontSize="inherit" />, () => onChange((nb) => deleteCell(nb, index)))}
      </Box>
      {rendered
        ? <Box data-testid="rendered-markdown" onDoubleClick={() => editable && setEditing(true)} sx={{ px: 1.5, py: 0.5, cursor: editable ? 'text' : 'default' }}><Markdown>{src}</Markdown></Box>
        : <>
          {type === 'markdown' && editable && (
            <Stack direction="row" role="toolbar" aria-label={`Formatting for cell ${index + 1}`} sx={{ px: 0.5, borderBottom: 1, borderColor: 'divider', flexWrap: 'wrap' }}>
              {TOOLS.map(([name, Icon, kind]) => (
                <Tooltip key={kind} title={name}><IconButton size="small" aria-label={name} onMouseDown={(e) => e.preventDefault()} onClick={() => format(kind)}><Icon fontSize="small" /></IconButton></Tooltip>
              ))}
            </Stack>)}
          <Box component="textarea" ref={ta} aria-label={`Source of cell ${index + 1}`} value={src} readOnly={!editable} spellCheck={false} rows={Math.max(2, src.split('\n').length)}
            onChange={(e) => onChange((nb) => setSource(nb, index, e.target.value))} onBlur={() => setEditing(false)} autoFocus={editing}
            sx={{ ...mono, display: 'block', width: '100%', boxSizing: 'border-box', resize: 'vertical', border: 0, outline: 'none', p: 1.5, bgcolor: 'transparent', color: 'text.primary', lineHeight: 1.5, '&:focus': { bgcolor: 'action.hover' } }} />
        </>}
      <Box sx={{ px: 1, pb: type === 'code' && (outputsOf(cell).length || runner.runningKey === cellKey(cell, index)) ? 1 : 0 }}><Outputs cell={cell} live={runner.runningKey === cellKey(cell, index) ? runner.live : undefined} /></Box>
    </Box>
  );
}

// Visual notebook editor. It is a view on the raw JSON tab: every edit writes a new JSON text through onChange, so the two
// stay in sync and saving, dirty marks and undo of the file all belong to the JSON tab. Nothing is executed (there is no kernel).
export default function NotebookEditor({ project, source, content, editable, dirty, onChange, onSave, onActions }) {
  const parsed = useMemo(() => parseNotebook(content), [content]);
  const latest = useRef(content); latest.current = content; // a run outlives many renders: its result must land on the newest text
  const { run: stepUp, dialog } = useStepUp();
  const [canRun, setCanRun] = useState(false);
  const [running, setRunning] = useState(null); // { key, live: nbformat outputs so far }
  const [runErr, setRunErr] = useState('');
  const ctl = useRef(null);
  // Running cells needs shell access on the server (admin setting + the terminal.use permission), otherwise there are no run buttons.
  useEffect(() => {
    let live = true; setCanRun(false);
    if (project) get(`/api/terminal/status?projectId=${project.id}`).then((s) => { if (live) setCanRun(!!(s.enabled && s.canUse)); }).catch(() => {});
    return () => { live = false; ctl.current?.abort(); }; // leaving the tab ends the stream, and the server interrupts the cell
  }, [project?.id]); // eslint-disable-line
  const body = { projectId: project?.id, path: source };
  // Runs the cell with this key (looked up in the newest text, so a "run all" sees edits made meanwhile). Resolves true when it finished without an error.
  const runCell = async (key) => {
    const nb0 = parseNotebook(latest.current).nb, cell = nb0?.cells.find((c, j) => cellKey(c, j) === key);
    if (!cell) return false;
    let outs = [], count = null, ok = true; const ac = new AbortController(); ctl.current = ac;
    setRunErr(''); setRunning({ key, live: [] });
    try {
      await stepUp(() => streamPost('/api/terminal/kernel/run', { ...body, code: sourceText(cell) }, (ev) => {
        if (ev.t === 'done') { count = ev.count; return; }
        if (ev.t === 'error') ok = false;
        outs = appendEvent(outs, ev); setRunning({ key, live: outs });
      }, ac.signal));
      if (ac.signal.aborted) return false;
      if (editable) { const nb = parseNotebook(latest.current).nb; if (nb) { const json = serializeNotebook(applyRun(nb, key, outs, count)); latest.current = json; onChange(json); } } // latest first: a following cell of "run all" reads it before React re-renders
      return ok;
    } catch (e) {
      if (e.name !== 'AbortError' && e.message !== 'canceled') setRunErr(e.body?.error === 'shell_disabled' ? 'Shell access is turned off.' : e.body?.error === 'too_many_kernels' ? 'Too many notebook kernels are open. Restart or close another notebook first.' : e.body?.message || 'Could not run the cell.');
      return false;
    } finally { setRunning(null); }
  };
  // Runs every non-empty code cell top to bottom and stops at the first error, or when the run is stopped.
  const [all, setAll] = useState(false);
  const runAll = async () => {
    const keys = parseNotebook(latest.current).nb.cells.map((c, j) => [c, cellKey(c, j)]).filter(([c]) => c.cell_type === 'code' && sourceText(c).trim()).map(([, k]) => k);
    setAll(true);
    try { for (const k of keys) { if (!(await runCell(k))) break; } } finally { setAll(false); }
  };
  const stop = () => post('/api/terminal/kernel/interrupt', body).catch(() => {});
  const restart = async () => { try { await post('/api/terminal/kernel/restart', body); setRunErr(''); } catch { setRunErr('Could not restart the kernel.'); } };
  const runner = { canRun: canRun && !!parsed.nb && isPython(parsed.nb), runningKey: running?.key ?? null, live: running?.live, run: runCell, stop };
  const hasCode = !!parsed.nb && parsed.nb.cells.some((c) => c.cell_type === 'code' && sourceText(c).trim());
  // The editor menu bar hosts Run all / Restart kernel / Save: hand it the current state, and stable callbacks that reach the newest closures.
  const fns = useRef({}); fns.current = { runAll, stop, restart, save: () => onSave?.() };
  const canRunNb = runner.canRun, busy = running !== null;
  useEffect(() => {
    onActions?.({ canRun: canRunNb, all, busy, hasCode, editable, dirty, runAll: () => fns.current.runAll(), stop: () => fns.current.stop(), restart: () => fns.current.restart(), save: () => fns.current.save() });
  }, [canRunNb, all, busy, hasCode, editable, dirty]); // eslint-disable-line
  useEffect(() => () => onActions?.(null), []); // eslint-disable-line
  const edit = (fn) => { if (parsed.nb && editable) onChange(serializeNotebook(fn(parsed.nb))); };
  const onKeyDown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (editable && dirty) onSave?.(); } };
  return (
    <Box role="document" aria-label={`Notebook editor for ${source}`} data-testid="notebook-editor" onKeyDown={onKeyDown} sx={{ height: '100%', overflow: 'auto', bgcolor: 'background.paper' }}>
      <Box sx={{ maxWidth: 1000, mx: 'auto', px: 3, py: 2 }}>
        <Card variant="outlined" data-testid="notebook-info" sx={{ px: 1.5, py: 1, mb: 1.5 }}>
          <Typography variant="caption" color="text.secondary">
            {source}{editable ? '' : ' (read-only)'} {runner.canRun ? ' · cells run in a Python process on the server' : ' · cells cannot be run (needs server shell access)'}
          </Typography>
        </Card>
        {runErr && <Alert severity="error" onClose={() => setRunErr('')} sx={{ mb: 1 }}>{runErr}</Alert>}
        {parsed.error
          ? <Typography role="alert" color="error" sx={{ ...mono }}>{parsed.error}. Fix it in the raw JSON tab.</Typography>
          : <>
              {parsed.nb.cells.length === 0 && <Typography color="text.secondary" sx={{ fontStyle: 'italic', mb: 1.5 }}>This notebook has no cells.</Typography>}
              {parsed.nb.cells.map((c, i) => (
                <Box key={c.id || i}>
                  <Gap index={i} editable={editable} onInsert={(at, type) => edit((nb) => insertCell(nb, at, type))} />
                  <Cell cell={c} index={i} count={parsed.nb.cells.length} editable={editable} onChange={edit} runner={runner} />
                </Box>
              ))}
              <Box sx={{ mt: 1.5 }} /><Box sx={{ display: 'flex', gap: 1 }}>
                <Button size="small" startIcon={<AddIcon />} disabled={!editable} onClick={() => edit((nb) => insertCell(nb, nb.cells.length, 'code'))}>Code cell</Button>
                <Button size="small" startIcon={<AddIcon />} disabled={!editable} onClick={() => edit((nb) => insertCell(nb, nb.cells.length, 'markdown'))}>Markdown cell</Button>
              </Box>
            </>}
      </Box>
      {dialog}
    </Box>
  );
}
