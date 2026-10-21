import { useEffect, useRef, useState } from 'react';
import { Box, ButtonBase, Chip, CircularProgress, Collapse, Typography } from '@mui/material';
import PsychologyIcon from '@mui/icons-material/PsychologyOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SearchIcon from '@mui/icons-material/Search';

// Providers report one output-token total that already includes reasoning, so the thinking size is estimated the same way the rest
// of the app estimates tokens (about 4 characters each), and shown with "~".
export const estimateThinkingTokens = (text) => Math.ceil((text || '').length / 4);
// Under 1,000 shows the exact estimate; from there on "1.0k", "1.1k"... (truncated, so 1,999 never reads as 2.0k).
export const fmtThinkingTokens = (n) => (n >= 1000 ? `${(Math.floor(n / 100) / 10).toFixed(1)}k` : String(n));

// Streamed reasoning from models that expose it. Open while the model is still thinking, collapses once the answer starts
// (the user can always toggle it).
export default function ThinkingBlock({ text, live, searches = [] }) {
  const [userOpen, setUserOpen] = useState(null);
  const open = userOpen ?? !!live;
  const body = useRef(null);
  useEffect(() => { if (live && body.current) body.current.scrollTop = body.current.scrollHeight; }, [text, live]);
  const hasText = !!text?.trim();
  if (!hasText && !searches.length) return null;
  const tokens = estimateThinkingTokens(text);
  return (
    <Box sx={{ my: 1 }} data-testid="thinking">
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
      <ButtonBase onClick={() => setUserOpen(!open)} aria-expanded={open} aria-label={live ? 'Thinking' : 'Thought process'} disabled={!hasText}
        sx={{ width: '100%', justifyContent: 'flex-start', gap: 1, px: 1.25, py: 0.5, color: 'text.secondary', textAlign: 'left' }}>
        {live ? <CircularProgress size={14} /> : <PsychologyIcon fontSize="small" />}
        <Typography variant="caption" sx={{ flexGrow: 1 }}>{live ? (hasText ? 'Thinking…' : 'Searching…') : (hasText ? 'Thought process' : 'Searched the web')}</Typography>
        <ExpandMoreIcon fontSize="small" sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </ButtonBase>
      {searches.length > 0 && (
        <Box data-testid="searches" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1.25, py: 0.75, borderTop: 1, borderColor: 'divider' }}>
          {searches.map((q, k) => <Chip key={k} size="small" variant="outlined" icon={<SearchIcon />} label={q} title={`Searched the web: ${q}`} sx={{ maxWidth: '100%' }} />)}
        </Box>
      )}
      <Collapse in={open && hasText} unmountOnExit>
        <Box ref={body} sx={{ px: 1.5, py: 1, maxHeight: 240, overflow: 'auto', borderTop: 1, borderColor: 'divider', bgcolor: 'action.hover' }}>
          <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontStyle: 'italic' }}>{text}</Typography>
        </Box>
      </Collapse>
    </Box>
    {hasText && <Typography variant="caption" color="text.secondary" data-testid="thinking-tokens" sx={{ display: 'block', mt: 0.25, ml: 0.5 }}>~{fmtThinkingTokens(tokens)} {tokens === 1 ? 'token' : 'tokens'}{live ? ' so far' : ''}</Typography>}
    </Box>
  );
}
