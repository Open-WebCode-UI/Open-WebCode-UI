import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import { get, post, put, del } from '../api.js';
import { useAuth } from '../AuthContext.jsx';

const NAME_HELP = '2–39 characters: lowercase letters, digits, and dashes. Invoke it by typing /name in a message.';

const INTRO = {
  agent: <>Reusable instructions for jobs like code or security review. The agent loads a skill when a request matches its description, or you can run one yourself by typing <code>/skill-name</code> (optionally followed by what to apply it to). Skills never give the agent extra tools or permissions, so Plan mode stays read-only.</>,
  chat: <>Reusable instructions for the Chat page, in both the General and Coding tabs. Run one by typing <code>/skill-name</code> followed by what to apply it to, or pick it from the Skills button. Chat has no access to your projects, so these skills work on what you paste or type. They are separate from the Agent skills.</>,
};

// A skill is a named set of instructions, invoked with /name. On the Agent page the agent can also load one itself (use_skill)
// when a request matches its description. Built-in skills can be edited and reset to the default. Agent and chat skills are separate.
export default function SkillsManager({ scope = 'agent' }) {
  const { can } = useAuth(); const edit = can('profile.skills.edit');
  const q = `?scope=${scope}`;
  const [skills, setSkills] = useState([]); const [dlg, setDlg] = useState(null); const [msg, setMsg] = useState(null);
  const load = useCallback(() => get(`/api/skills${q}`).then(setSkills).catch(() => {}), [q]);
  useEffect(() => { load(); }, [load]);
  const act = async (fn, ok) => { try { await fn(); setMsg({ s: 'success', t: ok }); load(); return true; } catch (e) { setMsg({ s: 'error', t: e.body?.message || e.body?.error || 'Failed' }); return false; } };

  const toggle = (s) => act(() => (s.builtin ? put(`/api/skills/builtin/${s.key}${q}`, { enabled: !s.enabled }) : put(`/api/skills/custom/${s.id}${q}`, { name: s.name, description: s.description, instructions: s.instructions, enabled: !s.enabled })), `${s.name} ${s.enabled ? 'disabled' : 'enabled'}`);
  const save = async (d) => {
    const body = { name: d.name, description: d.description, instructions: d.instructions, enabled: d.enabled };
    const ok = await act(() => (d.builtin ? put(`/api/skills/builtin/${d.key}${q}`, { description: d.description, instructions: d.instructions, enabled: d.enabled }) : d.id ? put(`/api/skills/custom/${d.id}${q}`, body) : post(`/api/skills${q}`, body)), 'Skill saved');
    if (ok) setDlg(null);
  };

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>{INTRO[scope]}</Typography>
      {msg && <Alert severity={msg.s} sx={{ mb: 1 }} onClose={() => setMsg(null)}>{msg.t}</Alert>}
      {edit && <Button variant="outlined" sx={{ mb: 1 }} onClick={() => setDlg({ name: '', description: '', instructions: '', enabled: true, builtin: false })}>New skill</Button>}
      {skills.map((s) => (
        <Paper key={s.key || s.id} variant="outlined" sx={{ p: 1.5, mb: 1 }} data-testid="skill-row">
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography sx={{ fontFamily: 'monospace', fontWeight: 600 }}>/{s.name}</Typography>
            {s.builtin && <Chip size="small" label={s.modified ? 'built-in (modified)' : 'built-in'} color={s.modified ? 'warning' : 'default'} variant="outlined" />}
            {s.action && <Chip size="small" label="command" variant="outlined" title="Runs on the server; its instructions are the summarizing prompt" />}
            <Box sx={{ flexGrow: 1 }} />
            <Switch size="small" checked={s.enabled} disabled={!edit} onChange={() => toggle(s)} slotProps={{ input: { 'aria-label': `Enable ${s.name}` } }} />
            <Button size="small" onClick={() => setDlg({ ...s })}>{edit ? 'Edit' : 'View'}</Button>
            {edit && s.builtin && s.modified && <Button size="small" color="warning" onClick={() => act(() => del(`/api/skills/builtin/${s.key}${q}`), `${s.name} reset to default`)}>Reset</Button>}
            {edit && !s.builtin && <Button size="small" color="error" onClick={() => window.confirm(`Delete ${s.name}?`) && act(() => del(`/api/skills/custom/${s.id}${q}`), 'Skill deleted')}>Delete</Button>}
          </Stack>
          <Typography variant="body2" color="text.secondary">{s.description}</Typography>
        </Paper>
      ))}
      {dlg && <SkillDialog scope={scope} init={dlg} canEdit={edit} onClose={() => setDlg(null)} onSave={save} />}
    </Box>
  );
}

function SkillDialog({ scope, init, canEdit, onClose, onSave }) {
  const [d, setD] = useState(init);
  const isNew = !init.builtin && !init.id;
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{isNew ? 'New skill' : `${canEdit ? 'Edit' : 'View'} /${init.name}`}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField size="small" label="Name" value={d.name} disabled={!isNew} onChange={(e) => setD({ ...d, name: e.target.value })} helperText={isNew ? NAME_HELP : undefined} />
          <TextField size="small" label={scope === 'chat' ? 'What is it for? (description)' : 'When should the agent use it? (description)'} value={d.description} disabled={!canEdit} onChange={(e) => setD({ ...d, description: e.target.value })} />
          <TextField multiline minRows={12} maxRows={26} label={d.action ? 'Summarizing prompt (Markdown)' : 'Instructions (Markdown)'} value={d.instructions} disabled={!canEdit} onChange={(e) => setD({ ...d, instructions: e.target.value })} slotProps={{ htmlInput: { 'aria-label': 'Skill instructions' } }} helperText={d.action ? `Type /${d.name} to run it. The agent uses this prompt to write the summary that replaces the old messages.` : undefined} />
          {d.builtin && d.defaults && canEdit && <Box><Button size="small" onClick={() => setD({ ...d, description: d.defaults.description, instructions: d.defaults.instructions })}>Load default text</Button></Box>}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</Button>{canEdit && <Button variant="contained" disabled={!d.name || !d.instructions.trim()} onClick={() => onSave(d)}>Save</Button>}</DialogActions>
    </Dialog>
  );
}
