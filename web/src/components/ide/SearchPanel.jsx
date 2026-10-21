import { useEffect, useRef, useState } from 'react';
import { Box, Button, CircularProgress, IconButton, InputBase, Stack, ToggleButton, Tooltip, Typography } from '@mui/material';
import ChevronRight from '@mui/icons-material/ChevronRight';
import ExpandMore from '@mui/icons-material/ExpandMore';
import { get } from '../../api.js';
import { baseName, dirName } from '../pathUtils.js';

const WHY = { invalid_pattern: 'Invalid regular expression', search_timeout: 'The search took too long; try a more specific pattern', too_many: '' };

// A line of a result with the matched text emphasised. Long lines are trimmed around the match so it stays visible.
function Snippet({ hit }) {
  const t = hit.text, from = hit.col - 1, lead = Math.max(0, from - 20), s = t.slice(lead);
  const i = from - lead;
  return <span>{lead > 0 ? '…' : ''}{s.slice(0, i)}<mark style={{ background: 'rgba(255,200,0,.45)', color: 'inherit' }}>{s.slice(i, i + hit.length)}</mark>{s.slice(i + hit.length)}</span>;
}

// "Search" view of the Explorer: find text in every file of the project (like VS Code's Search view). Results are grouped by
// file; clicking one opens the file at that match.
export default function SearchPanel({ project, focusTick, onOpenMatch, refreshKey }) {
  const [q, setQ] = useState(''); const [opts, setOpts] = useState({ case: false, word: false, regex: false });
  const [filters, setFilters] = useState(false); const [include, setInclude] = useState(''); const [exclude, setExclude] = useState('');
  const [state, setState] = useState(null); // { loading } | { error } | { results, matches, truncated }
  const [collapsed, setCollapsed] = useState({});
  const input = useRef(null); const seq = useRef(0);
  useEffect(() => { if (focusTick) { input.current?.focus(); input.current?.select(); } }, [focusTick]);
  useEffect(() => { setState(null); setCollapsed({}); }, [project?.id]);

  const run = async () => {
    if (!project || !q) { setState(null); return; }
    const n = ++seq.current;
    setState({ loading: true }); setCollapsed({});
    const qs = new URLSearchParams({ q, regex: opts.regex ? '1' : '0', case: opts.case ? '1' : '0', word: opts.word ? '1' : '0', ...(include.trim() ? { include } : {}), ...(exclude.trim() ? { exclude } : {}) });
    try { const r = await get(`/api/projects/${project.id}/search?${qs}`); if (n === seq.current) setState(r); }
    catch (e) { if (n === seq.current) setState({ error: WHY[e.body?.error] ?? 'Search failed' }); }
  };
  useEffect(() => { if (state && !state.loading) run(); }, [opts.case, opts.word, opts.regex, refreshKey]); // eslint-disable-line -- re-run an existing search when an option changes
  const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } };
  const toggle = (k, label, title) => (
    <Tooltip title={title}><ToggleButton size="small" value={k} selected={opts[k]} aria-label={title} aria-pressed={opts[k]} onChange={() => setOpts((o) => ({ ...o, [k]: !o[k] }))} sx={{ px: 0.75, py: 0, minWidth: 26, textTransform: 'none', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6 }}>{label}</ToggleButton></Tooltip>
  );
  const field = (value, set, label, placeholder) => <InputBase fullWidth size="small" value={value} onChange={(e) => set(e.target.value)} onKeyDown={onKey} placeholder={placeholder} inputProps={{ 'aria-label': label }} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, px: 1, fontSize: 13 }} />;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Box sx={{ p: 1 }}>
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ border: 1, borderColor: 'divider', borderRadius: 1, pl: 1, pr: 0.5 }}>
          <InputBase inputRef={input} fullWidth value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search" inputProps={{ 'aria-label': 'Search files' }} sx={{ fontSize: 13 }} />
          {toggle('case', 'Aa', 'Match case')}{toggle('word', 'ab', 'Match whole word')}{toggle('regex', '.*', 'Use regular expression')}
        </Stack>
        <Stack direction="row" alignItems="center" sx={{ mt: 0.5 }}>
          <Button size="small" onClick={() => setFilters((f) => !f)} aria-expanded={filters} sx={{ textTransform: 'none', minWidth: 0, fontSize: 12 }}>{filters ? 'Hide' : 'Show'} file filters</Button>
          <Box sx={{ flexGrow: 1 }} />
          <Button size="small" variant="contained" disabled={!q || !project} onClick={run} sx={{ minWidth: 0, py: 0 }}>Search</Button>
        </Stack>
        {filters && <Stack spacing={0.5} sx={{ mt: 0.5 }}>{field(include, setInclude, 'Files to include', 'Files to include (e.g. *.js, src)')}{field(exclude, setExclude, 'Files to exclude', 'Files to exclude (e.g. *.test.js)')}</Stack>}
      </Box>
      <Box sx={{ flexGrow: 1, overflow: 'auto', px: 0.5, pb: 1 }} aria-live="polite">
        {state?.loading && <Box sx={{ p: 1, display: 'flex', gap: 1, alignItems: 'center' }}><CircularProgress size={14} /><Typography variant="body2">Searching…</Typography></Box>}
        {state?.error && <Typography variant="body2" color="error" sx={{ p: 1 }}>{state.error}</Typography>}
        {state?.results && (
          <>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1, pb: 0.5 }}>
              {state.matches ? `${state.matches}${state.truncated ? '+' : ''} result${state.matches === 1 ? '' : 's'} in ${state.results.length} file${state.results.length === 1 ? '' : 's'}${state.truncated ? ' (showing the first matches; narrow your search)' : ''}` : 'No results found'}
            </Typography>
            {state.results.map((f) => (
              <Box key={f.path}>
                <Stack direction="row" alignItems="center" onClick={() => setCollapsed((c) => ({ ...c, [f.path]: !c[f.path] }))} sx={{ cursor: 'pointer', px: 0.5, '&:hover': { bgcolor: 'action.hover' } }} role="button" aria-expanded={!collapsed[f.path]} aria-label={`${f.path}, ${f.hits.length} matches`}>
                  {collapsed[f.path] ? <ChevronRight fontSize="small" /> : <ExpandMore fontSize="small" />}
                  <Typography variant="body2" noWrap sx={{ fontWeight: 600, ml: 0.5 }}>{baseName(f.path)}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ ml: 1, flexGrow: 1, minWidth: 0 }}>{dirName(f.path)}</Typography>
                  <Typography variant="caption" sx={{ bgcolor: 'action.selected', borderRadius: 3, px: 0.75 }}>{f.hits.length}</Typography>
                </Stack>
                {!collapsed[f.path] && f.hits.map((h, i) => (
                  <Box key={i} role="button" tabIndex={0} onClick={() => onOpenMatch(f.path, h)} onKeyDown={(e) => { if (e.key === 'Enter') onOpenMatch(f.path, h); }}
                    sx={{ pl: 3.5, pr: 1, py: 0.1, cursor: 'pointer', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', '&:hover': { bgcolor: 'action.hover' } }} title={`${f.path}:${h.line}`}>
                    <Snippet hit={h} />
                  </Box>
                ))}
              </Box>
            ))}
          </>
        )}
      </Box>
    </Box>
  );
}
