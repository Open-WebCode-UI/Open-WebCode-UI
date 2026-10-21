import { useState } from 'react';
import { Box, ButtonBase, Chip, CircularProgress, Collapse, Paper, Stack, Typography } from '@mui/material';
import SmartToyIcon from '@mui/icons-material/SmartToyOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CheckIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorIcon from '@mui/icons-material/ErrorOutlined';
import Markdown from './Markdown.jsx';
import { CheckpointChip, ToolCard, TOOL_META } from './AgentItems.jsx';

const STATUS = { complete: ['Done', 'success'], partial: ['Partly done', 'warning'], blocked: ['Blocked', 'error'], running: ['Working…', 'default'] };

// A subagent the agent started: one card containing the child's own steps, so the parent conversation stays readable.
export default function SubagentCard({ item, onOpenCheckpoint }) {
  const [userOpen, setUserOpen] = useState(null);
  const running = item.status === 'running';
  const open = userOpen ?? false;
  const [label, color] = STATUS[item.status] || STATUS.complete;
  const last = [...item.steps].reverse().find((s) => s.kind === 'tool');
  const activity = running ? (last ? (last.result === undefined ? (TOOL_META[last.name]?.now(last.args || {}) ?? `Running ${last.name}`) : (TOOL_META[last.name]?.done(last.args || {}) ?? last.name)) : 'Starting…') : null;
  return (
    <Paper variant="outlined" data-testid="subagent" data-status={item.status} data-mode={item.mode} sx={{ ml: 2, borderLeft: 4, borderLeftColor: item.mode === 'act' ? 'warning.main' : 'info.main', overflow: 'hidden' }}>
      <ButtonBase onClick={() => setUserOpen(!open)} aria-expanded={open} aria-label={`Subagent ${item.name}`} sx={{ width: '100%', justifyContent: 'flex-start', gap: 1, px: 1.25, py: 0.75, textAlign: 'left' }}>
        <SmartToyIcon fontSize="small" color={item.mode === 'act' ? 'warning' : 'info'} />
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>Subagent: {item.name}</Typography>
          {activity && <Typography variant="caption" color="text.secondary" noWrap display="block">{activity}</Typography>}
        </Box>
        <Chip size="small" variant="outlined" label={item.mode === 'act' ? 'can edit files' : 'read-only'} />
        {running ? <CircularProgress size={14} /> : <Chip size="small" color={color} label={label} icon={item.status === 'blocked' ? <ErrorIcon /> : <CheckIcon />} />}
        <ExpandMoreIcon fontSize="small" sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
      </ButtonBase>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ px: 1.5, py: 1, borderTop: 1, borderColor: 'divider', bgcolor: 'action.hover' }}>
          {item.downgraded && <Typography variant="caption" color="warning.main" display="block" sx={{ mb: 0.5 }}>Edit mode was requested but is not allowed here, so this subagent is read-only.</Typography>}
          <Typography variant="caption" color="text.secondary">Task</Typography>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mb: 1 }}>{item.task}</Typography>
          <Stack spacing={0.75}>
            {item.steps.map((s, i) => (s.kind === 'tool' ? <Box key={i} sx={{ '& > *': { ml: 0 } }}><ToolCard t={s} /></Box>
              : s.kind === 'checkpoint' ? <CheckpointChip key={i} cpId={s.cpId} label={s.label} onOpen={onOpenCheckpoint} />
              : <Box key={i}><Markdown>{s.text}</Markdown></Box>))}
          </Stack>
          {item.summary && <Box sx={{ mt: 1, pt: 1, borderTop: 1, borderColor: 'divider' }}><Typography variant="caption" color="text.secondary">Report</Typography><Markdown>{item.summary}</Markdown></Box>}
        </Box>
      </Collapse>
    </Paper>
  );
}
