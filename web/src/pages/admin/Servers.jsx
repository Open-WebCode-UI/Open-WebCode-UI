import { useEffect, useState, useCallback } from 'react';
import { Box, Typography, Button, Paper, Stack, Chip, Dialog, DialogTitle, DialogContent, DialogActions, Alert, Table, TableHead, TableRow, TableCell, TableBody, Switch, IconButton, Autocomplete, TextField, CircularProgress, MenuItem } from '@mui/material';
import DeleteIcon from '@mui/icons-material/DeleteOutlined';
import ArrowUpIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownIcon from '@mui/icons-material/ArrowDownward';
import { get, post, put, del } from '../../api.js';
import { useAuth } from '../../AuthContext.jsx';
import { useStepUp } from '../../components/StepUp.jsx';
import { Text, Pick, Bool, Num, errText } from './common.jsx';
import BadgesDialog from './Badges.jsx';
import ModelBadges from '../../components/ModelBadges.jsx';

const TYPES = [['openai', 'OpenAI (ChatGPT)'], ['anthropic', 'Anthropic'], ['lmstudio', 'LM Studio'], ['ollama', 'Ollama'], ['generic', 'OpenAPI-compatible (self-hosted)'], ['gemini', 'Google Gemini'], ['mistral', 'Mistral AI'], ['bedrock', 'AWS Bedrock'], ['vertex', 'Google Vertex AI'], ['azure', 'Azure OpenAI']];
// Pre-filled into the Base URL field; the admin can still edit it (proxies, gateways). Azure and Bedrock have no fixed URL.
const DEFAULT_URL = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com', lmstudio: 'http://localhost:1234/v1', ollama: 'http://localhost:11434/v1', generic: 'http://localhost:8000/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/', mistral: 'https://api.mistral.ai/v1' };
const HINT = {
  gemini: 'Google AI Studio API key. The base URL is pre-filled with Google\'s OpenAI-compatible Gemini endpoint; change it only to use a proxy or gateway.',
  mistral: 'Mistral AI API key (from console.mistral.ai). The base URL is pre-filled; change it only to use a proxy or gateway.',
  openai: 'OpenAI\'s hosted API (the ChatGPT models). API key and base URL (pre-filled for OpenAI; change it for any other hosted OpenAI-compatible service).', anthropic: 'API key. The base URL is pre-filled; change it only to use a proxy or gateway.', lmstudio: 'Local server URL (pre-filled with the LM Studio default; private addresses allowed for this type only).', ollama: 'Local Ollama server URL (pre-filled with the Ollama default, which serves an OpenAI-compatible API under /v1; private addresses allowed for this type only). No API key is needed.', generic: 'For self-hosted servers that expose an OpenAI-style chat-completions API, often listed as "OpenAPI-compatible". Enter the base URL of any such server (vLLM, llama.cpp, LocalAI, LiteLLM, …). The API key is optional; private addresses allowed for this type only.',
  vertex: 'Google Cloud project ID and location (e.g. us-central1, or global). Secret: a service-account key (JSON) with the Vertex AI User role, or leave empty to use the server\'s Application Default Credentials. This is the native Vertex AI API, not the OpenAI-compatible Gemini endpoint.',
  bedrock: 'AWS region. Secret as ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN], or leave empty to use the server\'s IAM role/credentials.', azure: 'Resource endpoint (https://<resource>.openai.azure.com) and key. Azure routes by deployment name, so deployments are listed as the available models.',
};

export default function Servers() {
  const { can } = useAuth(); const write = can('provider.write');
  const { run, dialog } = useStepUp();
  const [list, setList] = useState([]); const [edit, setEdit] = useState(null); const [msg, setMsg] = useState(null); const [roles, setRoles] = useState([]);
  const [defs, setDefs] = useState({}); const [editModel, setEditModel] = useState(null);
  const [badges, setBadges] = useState({ categories: [], badges: [] }); const [manageBadges, setManageBadges] = useState(false);
  const loadBadges = useCallback(() => get('/api/admin/badges').then(setBadges).catch(() => {}), []);
  const loadDefs = useCallback(() => get('/api/models').then((r) => setDefs(r.defaults || {})).catch(() => {}), []);
  const load = useCallback(() => get('/api/admin/providers').then(setList).catch((e) => setMsg({ s: 'error', t: errText(e) })), []);
  useEffect(() => { load(); loadDefs(); loadBadges(); if (can('role.read')) get('/api/admin/roles').then((r) => setRoles(r.roles.map((x) => x.name))).catch(() => {}); }, [load, loadDefs, loadBadges]); // eslint-disable-line

  // Moves one item a step up or down and saves the whole order; the model picker uses the same order.
  const move = async (url, items, i, dir) => {
    const ids = items.map((x) => x.id); const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await put(url, { ids }); } catch (e) { setMsg({ s: 'error', t: errText(e) }); }
    load(); loadDefs();
  };

  const test = async (p) => { const r = await post(`/api/admin/providers/${p.id}/test`); setMsg(r.ok ? { s: 'success', t: `Connected to ${p.name}. ${r.models.length} model(s) discovered.` } : { s: 'error', t: `Connection failed: ${r.error}` }); setEdit((e) => e && e.id === p.id ? { ...e, discovered: r.models || [] } : e); };

  return (
    <Box>
      <Typography variant="h5" gutterBottom>Server settings — AI services</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Connect to model providers, choose which models users can pick, and set the defaults for Plan, Act, and Chat.</Typography>
      {msg && <Alert severity={msg.s} sx={{ mb: 2 }} onClose={() => setMsg(null)}>{msg.t}</Alert>}
      {write && <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        <Button variant="contained" onClick={() => setEdit({ name: '', type: 'openai', config: { baseUrl: DEFAULT_URL.openai }, secret: '', enabled: true, allowedRoles: [], helpText: '', models: [] })}>Add connection</Button>
        <Button variant="outlined" onClick={() => setManageBadges(true)}>Manage badges</Button>
      </Stack>}
      {list.map((p, pi) => (
        <Paper key={p.id} variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            {write && <Order label={p.name} first={pi === 0} last={pi === list.length - 1} onMove={(d) => move('/api/admin/providers/order', list, pi, d)} />}
            <Typography variant="h6" sx={{ flexGrow: 1 }}>{p.name}</Typography>
            <Chip size="small" label={TYPES.find((t) => t[0] === p.type)?.[1]} /><Chip size="small" color={p.enabled ? 'success' : 'default'} label={p.enabled ? 'Enabled' : 'Disabled'} />
            {write && <><Button size="small" onClick={() => test(p)}>Test</Button><Button size="small" onClick={() => setEdit(p)}>Edit</Button>
              <Button size="small" color="error" onClick={async () => { if (window.confirm(`Delete ${p.name}?`)) { await run(() => del(`/api/admin/providers/${p.id}`)).catch(() => {}); load(); } }}>Delete</Button></>}
          </Stack>
          <Typography variant="body2" color="text.secondary">{p.config.baseUrl || p.config.region || ''} {p.hasSecret ? '· key stored (hidden)' : ''} {p.allowedRoles.length ? `· roles: ${p.allowedRoles.join(', ')}` : '· all roles'}</Typography>
          {p.helpText && <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }}>{p.helpText}</Typography>}
          <Table size="small" sx={{ mt: 1 }}><TableHead><TableRow><TableCell>Model</TableCell><TableCell>Details</TableCell><TableCell>Default for</TableCell><TableCell /></TableRow></TableHead>
            <TableBody>{p.models.map((m, mi) => <ModelRow key={m.id} m={m} p={p} write={write} first={mi === 0} last={mi === p.models.length - 1} onMove={(d) => move(`/api/admin/providers/${p.id}/models/order`, p.models, mi, d)} defs={defs} badges={badges.badges} onEdit={() => setEditModel({ m, p })} reload={load} />)}</TableBody></Table>
          {write && <AddModel p={p} reload={load} />}
        </Paper>
      ))}
      {!list.length && <Typography color="text.secondary">No AI connections configured yet.</Typography>}
      {edit && <ProviderDialog init={edit} roles={roles} onClose={() => { setEdit(null); }} onTest={test} onSaved={() => { setEdit(null); load(); }} run={run} />}
      {manageBadges && <BadgesDialog data={badges} reload={async () => { await loadBadges(); load(); }} onClose={() => setManageBadges(false)} />}
      {editModel && <ModelDialog init={editModel.m} p={editModel.p} defs={defs} badges={badges} run={run} onClose={() => setEditModel(null)} onSaved={() => { setEditModel(null); load(); loadDefs(); }} />}
      {dialog}
    </Box>
  );
}

const num = (v) => (v === '' || v == null ? null : Number(v));
const upOptions = (inherited) => [['inherit', `Use connection setting (${inherited ? 'on' : 'off'})`], ['on', 'On'], ['off', 'Off']];
const THINKING = { off: 'Off', adaptive: 'Adaptive', budget: 'Budget' };

// Up/down buttons (keyboard accessible, no drag needed).
function Order({ label, first, last, onMove }) {
  return (
    <Stack direction="row" sx={{ mr: 0.5 }}>
      <IconButton size="small" aria-label={`Move ${label} up`} disabled={first} onClick={() => onMove(-1)}><ArrowUpIcon fontSize="inherit" /></IconButton>
      <IconButton size="small" aria-label={`Move ${label} down`} disabled={last} onClick={() => onMove(1)}><ArrowDownIcon fontSize="inherit" /></IconButton>
    </Stack>
  );
}

function ModelRow({ m, write, defs, badges, onEdit, reload, first, last, onMove }) {
  const details = [m.autoContext ? 'Auto context' : m.contextSize && `${m.contextSize.toLocaleString()} context`, m.subagents !== false && 'Subagents', m.fileUploads === true && 'Files', m.imageUploads === true && 'Images', m.fileUploads === false && 'No files', m.imageUploads === false && 'No images', m.thinkingMode && m.thinkingMode !== 'off' && `Thinking: ${THINKING[m.thinkingMode]}`,
    (m.inputPrice != null || m.outputPrice != null) && `$${m.inputPrice ?? '—'} in / $${m.outputPrice ?? '—'} out per 1M`].filter(Boolean);
  return (
    <TableRow>
      <TableCell>
        <Stack direction="row" spacing={1} alignItems="center">{write && <Order label={m.label} first={first} last={last} onMove={onMove} />}<Typography variant="body2">{m.label}</Typography>{!m.enabled && <Chip size="small" label="Disabled" />}</Stack>
        {m.label !== m.modelId && <Typography variant="caption" color="text.secondary" component="code">{m.modelId}</Typography>}
      </TableCell>
      <TableCell><Typography variant="caption" color="text.secondary">{details.join(' · ')}</Typography>
        <ModelBadges badges={(m.badgeIds || []).map((id) => badges.find((b) => b.id === id)).filter(Boolean)} featuredId={m.featuredBadgeId} sx={{ mt: 0.5 }} /></TableCell>
      <TableCell>{['plan', 'act', 'chat'].filter((k) => defs?.[k] === m.id).map((k) => <Chip key={k} size="small" color="primary" sx={{ mr: 0.5 }} label={k} />)}</TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
        {write && <Button size="small" aria-label={`Edit ${m.label}`} onClick={onEdit}>Edit</Button>}
        {write && <IconButton size="small" aria-label={`Remove ${m.label}`} onClick={async () => { await del(`/api/admin/models/${m.id}`); reload(); }}><DeleteIcon fontSize="inherit" /></IconButton>}
      </TableCell>
    </TableRow>
  );
}

// Everything about one model in one place. Saving writes the model, then moves the Plan/Act/Chat defaults if they changed.
function ModelDialog({ init, p, defs, badges, run, onClose, onSaved }) {
  const [f, setF] = useState({
    label: init.label, enabled: init.enabled, subagents: init.subagents !== false, fileUploads: init.fileUploads ?? '', imageUploads: init.imageUploads ?? '', contextSize: init.contextSize ?? '', autoContext: !!init.autoContext, maxTokens: init.maxTokens ?? 4096,
    inputPrice: init.inputPrice ?? '', outputPrice: init.outputPrice ?? '', thinkingMode: init.thinkingMode || 'off', thinkingBudget: init.thinkingBudget || 8000, helpText: init.helpText || '', badgeIds: init.badgeIds || [], featuredBadgeId: init.featuredBadgeId ?? null,
  });
  const [dflt, setDflt] = useState({ plan: defs.plan === init.id, act: defs.act === init.id, chat: defs.chat === init.id });
  const [err, setErr] = useState('');
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setErr('');
    try {
      await run(async () => {
        await post(`/api/admin/providers/${p.id}/models`, {
          modelId: init.modelId, label: f.label.trim() || init.modelId, enabled: f.enabled, subagents: f.subagents, fileUploads: f.fileUploads === '' ? null : f.fileUploads, imageUploads: f.imageUploads === '' ? null : f.imageUploads, maxTokens: Number(f.maxTokens) || 4096,
          temperature: init.temperature ?? null, contextSize: num(f.contextSize), autoContext: f.autoContext, inputPrice: num(f.inputPrice), outputPrice: num(f.outputPrice),
          thinkingMode: f.thinkingMode, ...(f.thinkingMode === 'budget' ? { thinkingBudget: Number(f.thinkingBudget) || 8000 } : {}), helpText: f.helpText.trim(),
        });
        const featured = f.badgeIds.includes(f.featuredBadgeId) ? f.featuredBadgeId : null;
        if (JSON.stringify([...f.badgeIds].sort()) !== JSON.stringify([...(init.badgeIds || [])].sort()) || featured !== (init.featuredBadgeId ?? null)) await put(`/api/admin/models/${init.id}/badges`, { badgeIds: f.badgeIds, featuredBadgeId: featured });
        const cur = (await get('/api/models')).defaults || {}, next = { plan: cur.plan ?? null, act: cur.act ?? null, chat: cur.chat ?? null };
        for (const k of ['plan', 'act', 'chat']) { if (dflt[k]) next[k] = init.id; else if (next[k] === init.id) next[k] = null; }
        if (['plan', 'act', 'chat'].some((k) => next[k] !== (cur[k] ?? null))) await put('/api/admin/default-models', next);
      });
      onSaved();
    } catch (e) { if (e.message !== 'canceled') setErr(errText(e)); }
  };
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="model-dialog-title">
      <DialogTitle id="model-dialog-title">Edit model<Typography variant="body2" color="text.secondary" component="div">{init.modelId} · {p.name}</Typography></DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {err && <Alert severity="error">{err}</Alert>}
          <Text label="Display name" value={f.label} onChange={set('label')} />
          <Text label="Help text for users (optional)" multiline minRows={2} value={f.helpText} onChange={set('helpText')} slotProps={{ htmlInput: { maxLength: 500 } }}
            helperText={`Shown on this model's card in the model picker. Plain text. ${f.helpText.length}/500`} />
          <Autocomplete multiple size="small" disableCloseOnSelect options={badges.badges} value={badges.badges.filter((b) => f.badgeIds.includes(b.id))}
            onChange={(_, v) => set('badgeIds')(v.map((b) => b.id))} getOptionLabel={(b) => b.label} isOptionEqualToValue={(a, b) => a.id === b.id}
            groupBy={(b) => badges.categories.find((c) => c.id === b.categoryId)?.name || 'Uncategorized'} noOptionsText="No badges yet. Use “Manage badges” on the page to add some."
            renderInput={(params) => <TextField {...params} label="Badges (optional)" helperText="Shown, grouped by category, under “Show more” on this model's card. Create and edit badges with “Manage badges”." />} />
          <Pick label="Featured badge" value={f.badgeIds.includes(f.featuredBadgeId) ? f.featuredBadgeId : 'none'} onChange={(v) => set('featuredBadgeId')(v === 'none' ? null : v)}
            options={[['none', 'None'], ...badges.badges.filter((b) => f.badgeIds.includes(b.id)).map((b) => [b.id, b.label])]}
            helperText="Optional. One of this model's badges, shown on its card without expanding it. Add the badge above first." />
          <Box>
            <Typography variant="subtitle2">Availability</Typography>
            <Bool label="Enabled (users can pick this model)" value={f.enabled} onChange={set('enabled')} />
            <Bool label="Subagents (the agent may delegate work to this model)" value={f.subagents} onChange={set('subagents')} />
          </Box>
          <Box>
            <Typography variant="subtitle2" gutterBottom>Uploads</Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Pick label="Files (PDFs, data, text)" value={f.fileUploads === '' ? 'inherit' : f.fileUploads ? 'on' : 'off'} onChange={(v) => set('fileUploads')(v === 'inherit' ? '' : v === 'on')} options={upOptions(p.fileUploads)} />
              <Pick label="Images" value={f.imageUploads === '' ? 'inherit' : f.imageUploads ? 'on' : 'off'} onChange={(v) => set('imageUploads')(v === 'inherit' ? '' : v === 'on')} options={upOptions(p.imageUploads)} />
            </Stack>
            <Typography variant="caption" color="text.secondary">Only allow images for models with vision support.</Typography>
          </Box>
          <Box>
            <Typography variant="subtitle2" gutterBottom>Limits and cost</Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Num label="Context window (tokens)" value={f.contextSize} onChange={set('contextSize')} placeholder="128000" disabled={f.autoContext} slotProps={{ htmlInput: { min: 1000, step: 1000 } }} />
              <Num label="Max reply (tokens)" value={f.maxTokens} onChange={set('maxTokens')} slotProps={{ htmlInput: { min: 1, step: 256 } }} />
            </Stack>
            <Bool label="Automatic context sizing" value={f.autoContext} onChange={set('autoContext')} />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 2 }}>
              <Num label="Input price ($ per 1M tokens)" value={f.inputPrice} onChange={set('inputPrice')} placeholder="—" slotProps={{ htmlInput: { min: 0, step: 0.01 } }} />
              <Num label="Output price ($ per 1M tokens)" value={f.outputPrice} onChange={set('outputPrice')} placeholder="—" slotProps={{ htmlInput: { min: 0, step: 0.01 } }} />
            </Stack>
          </Box>
          <Box>
            <Typography variant="subtitle2" gutterBottom>Thinking</Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Pick label="Thinking" value={f.thinkingMode} onChange={set('thinkingMode')} options={Object.entries(THINKING)} />
              {f.thinkingMode === 'budget' && <Num label="Thinking budget (tokens)" value={f.thinkingBudget} onChange={set('thinkingBudget')} slotProps={{ htmlInput: { min: 1024, step: 1000 } }} />}
            </Stack>
          </Box>
          <Box>
            <Typography variant="subtitle2">Default model for</Typography>
            <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap' }}>
              {[['plan', 'Plan'], ['act', 'Act'], ['chat', 'Chat']].map(([k, l]) => <Bool key={k} label={l} value={dflt[k]} onChange={(v) => setDflt((d) => ({ ...d, [k]: v }))} />)}
            </Stack>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Cancel</Button><Button variant="contained" onClick={save}>Save</Button></DialogActions>
    </Dialog>
  );
}

function AddModel({ p, reload }) {
  const [id, setId] = useState('');
  return <Stack direction="row" spacing={1} sx={{ mt: 1 }}><TextField size="small" label="Add model ID" value={id} onChange={(e) => setId(e.target.value)} /><Button disabled={!id} onClick={async () => { await post(`/api/admin/providers/${p.id}/models`, { modelId: id }); setId(''); reload(); }}>Add</Button></Stack>;
}

function ProviderDialog({ init, roles, onClose, onSaved, run }) {
  const [f, setF] = useState({ ...init, secret: '' }); const [err, setErr] = useState('');
  const existing = init.models || [];
  const [selected, setSelected] = useState(existing.map((m) => m.modelId));
  const [found, setFound] = useState(null); const [loading, setLoading] = useState(false); const [discoverErr, setDiscoverErr] = useState('');
  const cfg = (k) => (v) => setF({ ...f, config: { ...f.config, [k]: v } });
  const cleanCfg = () => Object.fromEntries(Object.entries(f.config).filter(([, v]) => v));

  // Ask the server which models this connection offers (works before the connection is saved).
  const load = async () => {
    setLoading(true); setDiscoverErr('');
    try {
      const r = await post('/api/admin/providers/discover', { type: f.type, config: cleanCfg(), ...(f.secret ? { secret: f.secret } : {}), ...(f.id ? { providerId: f.id } : {}) });
      if (r.ok) setFound(r.models); else { setFound(null); setDiscoverErr(r.error); }
    } catch (e) { setFound(null); setDiscoverErr(e.body?.message || errText(e)); } finally { setLoading(false); }
  };
  useEffect(() => { if (init.id) load(); }, []); // eslint-disable-line

  const save = async () => {
    setErr('');
    const body = { name: f.name, type: f.type, config: cleanCfg(), enabled: f.enabled, allowedRoles: f.allowedRoles, helpText: f.helpText || '', fileUploads: !!f.fileUploads, imageUploads: !!f.imageUploads, ...(f.secret ? { secret: f.secret } : {}) };
    try {
      const saved = await run(() => (f.id ? put(`/api/admin/providers/${f.id}`, body) : post('/api/admin/providers', body)));
      for (const modelId of selected.filter((m) => !existing.some((e) => e.modelId === m))) await post(`/api/admin/providers/${saved.id}/models`, { modelId });
      for (const m of existing.filter((e) => !selected.includes(e.modelId))) await del(`/api/admin/models/${m.id}`);
      onSaved();
    } catch (e) { if (e.message !== 'canceled') setErr(errText(e)); }
  };
  const options = [...new Set([...(found || []), ...existing.map((m) => m.modelId)])];
  const azure = f.type === 'azure';
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{f.id ? 'Edit connection' : 'Add connection'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {err && <Alert severity="error">{err}</Alert>}
          <Text label="Name" value={f.name} onChange={(v) => setF({ ...f, name: v })} />
          <Pick label="Type" value={f.type} onChange={(v) => {
            // Swap the pre-filled URL for the new type's, but never overwrite one the admin typed.
            const cur = f.config.baseUrl, keep = cur && cur !== DEFAULT_URL[f.type];
            setF({ ...f, type: v, config: { ...f.config, baseUrl: keep ? cur : DEFAULT_URL[v] || '' } }); setFound(null);
          }} options={TYPES} />
          <Alert severity="info">{HINT[f.type]}</Alert>
          {['openai', 'anthropic', 'lmstudio', 'ollama', 'generic', 'gemini', 'mistral', 'azure'].includes(f.type) && <Text label={azure ? 'Endpoint' : 'Base URL'} value={f.config.baseUrl} onChange={cfg('baseUrl')} />}
          {f.type === 'bedrock' && <Text label="AWS region" value={f.config.region} onChange={cfg('region')} />}
          {f.type === 'vertex' && <><Text label="Google Cloud project ID" value={f.config.project} onChange={cfg('project')} /><Text label="Location" value={f.config.location} onChange={cfg('location')} /></>}
          {azure && <Text label="API version (optional)" value={f.config.apiVersion} onChange={cfg('apiVersion')} />}
          <Text label={f.hasSecret ? 'API key / secret (leave blank to keep existing)' : 'API key / secret'} type="password" value={f.secret} onChange={(v) => setF({ ...f, secret: v })} autoComplete="off" />
          <Box>
            <Button variant="outlined" onClick={load} disabled={loading} startIcon={loading ? <CircularProgress size={16} /> : null}>{found ? 'Reload models' : 'Connect & load models'}</Button>
            {found && <Typography variant="caption" color="success.main" sx={{ ml: 1 }}>{found.length} model(s) available</Typography>}
          </Box>
          {discoverErr && <Alert severity="warning">Could not list models: {discoverErr}. You can still type model IDs below.</Alert>}
          <Autocomplete multiple freeSolo disableCloseOnSelect options={options} value={selected} onChange={(_, v) => setSelected(v.map((x) => String(x).trim()).filter(Boolean))}
            renderInput={(p) => <TextField {...p} size="small" label={azure ? 'Deployments to make available' : 'Models to make available'} helperText={found ? 'Choose from the list, or type an ID and press Enter.' : 'Load models above to pick from the server\'s list, or type IDs and press Enter.'} />} />
          <Autocomplete multiple options={roles} value={f.allowedRoles} onChange={(_, v) => setF({ ...f, allowedRoles: v })} renderInput={(p) => <TextField {...p} size="small" label="Restrict to roles (empty = all)" />} />
          <Text label="Help text for users (optional)" multiline minRows={2} value={f.helpText} onChange={(v) => setF({ ...f, helpText: v })} slotProps={{ htmlInput: { maxLength: 1000 } }}
            helperText={`Shown above this connection's models when users choose a model. Say what it is good for, where their data goes, or which to pick. Plain text. ${(f.helpText || '').length}/1000`} />
          <Box>
            <Typography variant="subtitle2">Uploads (default for this connection's models; a model can override)</Typography>
            <Bool label="Files (users can attach PDFs, data, and text files)" value={!!f.fileUploads} onChange={(v) => setF({ ...f, fileUploads: v })} />
            <Bool label="Images (only for models with vision support)" value={!!f.imageUploads} onChange={(v) => setF({ ...f, imageUploads: v })} />
          </Box>
          <Bool label="Enabled" value={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} />
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Cancel</Button><Button variant="contained" onClick={save} disabled={!f.name}>Save</Button></DialogActions>
    </Dialog>
  );
}
