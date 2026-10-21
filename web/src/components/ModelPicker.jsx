import { useState } from 'react';
import { Box, Button, ButtonBase, Chip, Collapse, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import TuneIcon from '@mui/icons-material/Tune';
import EffortSelect from './EffortSelect.jsx';
import ThinkingToggle from './ThinkingToggle.jsx';
import { BadgeChip, GroupedBadges } from './ModelBadges.jsx';

export const formatTokens = (n) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
const usd = (n) => `$${+n.toFixed(4)}`;
const KINDS = { plan: 'Plan', act: 'Act', chat: 'Chat' };

// Groups models by provider, in the order the providers first appear.
export function groupByProvider(models) {
  const groups = new Map();
  for (const m of models) { if (!groups.has(m.provider)) groups.set(m.provider, { provider: m.provider, help: m.help || '', models: [] }); groups.get(m.provider).models.push(m); }
  return [...groups.values()];
}

function ModelCard({ m, selected, defaultFor, onSelect }) {
  const [expanded, setExpanded] = useState(false);
  const priced = m.inputPrice != null || m.outputPrice != null;
  const facts = [m.autoContext ? 'Automatic context size' : m.contextSize && `${formatTokens(m.contextSize)} context`, m.maxTokens && `${formatTokens(m.maxTokens)} max reply`].filter(Boolean);
  const featured = m.badges?.find((b) => b.id === m.featuredBadgeId); // the one badge shown without expanding
  const hasDetails = !!(m.modelHelp || m.modelId || facts.length || priced || m.badges?.length);
  const detailsId = `model-details-${m.id}`;
  return (
    <Box sx={{ border: 2, borderRadius: 1, borderColor: selected ? 'primary.main' : 'divider', bgcolor: selected ? 'action.selected' : 'background.paper', '&:hover': { borderColor: selected ? 'primary.main' : 'text.disabled' } }}>
      <ButtonBase role="radio" aria-checked={selected} onClick={onSelect} sx={{ display: 'block', textAlign: 'left', width: '100%', p: 1.5, pb: hasDetails ? 0.5 : 1.5 }}>
        <Stack direction="row" alignItems="flex-start" spacing={1}>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ lineHeight: 1.3 }}>{m.label}</Typography>
            <Stack direction="row" useFlexGap spacing={0.5} sx={{ flexWrap: 'wrap', mt: 0.75 }}>
              {defaultFor.map((k) => <Chip key={k} size="small" color="primary" variant="outlined" label={`Default for ${KINDS[k]}`} />)}
              {m.supportsThinking && <Chip size="small" label="Thinking" />}
              {m.supportsFiles && <Chip size="small" label="Files" />}
              {m.supportsImages && <Chip size="small" label="Images" />}
              {featured && <BadgeChip badge={featured} />}
            </Stack>
          </Box>
          {selected && <CheckCircleIcon color="primary" fontSize="small" aria-hidden />}
        </Stack>
      </ButtonBase>
      {hasDetails && (
        <Box sx={{ px: 1.5, pb: 1 }}>
          <Button size="small" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded((v) => !v)} sx={{ textTransform: 'none', minWidth: 0, px: 0.5 }}
            endIcon={<ExpandMoreIcon sx={{ transform: expanded ? 'rotate(180deg)' : 'none' }} />}>{expanded ? 'Show less' : 'Show more'}</Button>
          <Collapse in={expanded} unmountOnExit>
            <Box id={detailsId} sx={{ pt: 0.5 }}>
              <GroupedBadges badges={m.badges} />
              {m.modelHelp && <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{m.modelHelp}</Typography>}
              {m.modelId && <Typography variant="caption" color="text.secondary" component="code" sx={{ display: 'block', mt: 0.5, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', wordBreak: 'break-all' }}>{m.modelId}</Typography>}
              {(facts.length > 0 || priced) && (
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                  {facts.join(' · ')}
                  {facts.length > 0 && priced && ' · '}
                  {priced && `${m.inputPrice != null ? `${usd(m.inputPrice)} in` : ''}${m.inputPrice != null && m.outputPrice != null ? ' / ' : ''}${m.outputPrice != null ? `${usd(m.outputPrice)} out` : ''} per 1M tokens`}
                </Typography>)}
            </Box>
          </Collapse>
        </Box>)}
    </Box>
  );
}

// The model button plus the dialog it opens: pick a model (with what an administrator wrote about its provider, its details and,
// when enabled, its price) and adjust how the model works (effort, thinking, and any extra controls such as web search).
//   defaults: { plan, act, chat } model ids; kinds: which of those apply on this screen; extra: more setting controls.
export default function ModelPicker({ models, value, onChange, defaults = {}, kinds = ['plan', 'act', 'chat'], effort, onEffort, thinking, onThinking, busy, extra, sx }) {
  const [open, setOpen] = useState(false);
  const current = models.find((m) => m.id === value);
  const groups = groupByProvider(models);
  return (
    <>
      <Button size="small" variant="outlined" color="inherit" aria-haspopup="dialog" aria-label={`Model: ${current ? `${current.label}, ${current.provider}` : 'none available'}`} onClick={() => setOpen(true)} startIcon={<TuneIcon />}
        sx={{ textTransform: 'none', justifyContent: 'flex-start', minWidth: 0, ...sx }}>
        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current ? <>{current.label} <Box component="span" sx={{ opacity: 0.65 }}>· {current.provider}</Box></> : 'No models'}</Box>
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm" scroll="paper" aria-labelledby="model-picker-title">
        <DialogTitle id="model-picker-title">Model &amp; settings</DialogTitle>
        <DialogContent dividers>
          {!models.length && <Typography color="text.secondary">No AI model is available. Ask an administrator to configure one.</Typography>}
          <Stack spacing={2.5} role="radiogroup" aria-label="Model">
            {groups.map((g) => (
              <Box key={g.provider} component="section" aria-label={g.provider}>
                <Typography variant="overline" color="text.secondary" component="h3" sx={{ lineHeight: 1.6 }}>{g.provider}</Typography>
                {g.help && <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap', mb: 1 }}>{g.help}</Typography>}
                <Stack spacing={1}>{g.models.map((m) => (
                  <ModelCard key={m.id} m={m} selected={m.id === value}
                    defaultFor={kinds.filter((k) => defaults[k] === m.id)} onSelect={() => onChange(m.id)} />))}</Stack>
              </Box>))}
          </Stack>
          <Box component="section" aria-label="Model settings" sx={{ mt: 3 }}>
            <Typography variant="overline" color="text.secondary" component="h3" sx={{ lineHeight: 1.6 }}>Settings</Typography>
            <Stack spacing={1.5} sx={{ '& .MuiFormControlLabel-root': { ml: 0 } }}>
              <Box><Typography variant="body2" gutterBottom>Effort</Typography><EffortSelect value={effort} disabled={busy} onChange={onEffort} /></Box>
              <ThinkingToggle model={current} value={thinking} disabled={busy} onChange={onThinking} />
              {extra}
            </Stack>
            {busy && <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>These can be changed again when the current turn finishes.</Typography>}
          </Box>
        </DialogContent>
        <DialogActions><Button onClick={() => setOpen(false)}>Done</Button></DialogActions>
      </Dialog>
    </>
  );
}
