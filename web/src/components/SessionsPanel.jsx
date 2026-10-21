import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, IconButton, List, ListItemButton, ListItemText, Menu, MenuItem, Stack, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { keyframes } from '@mui/system';
import { get } from '../api.js';
import { sessions, useSession } from '../sessionStore.js';
import { PromptDialog } from './ProjectDialogs.jsx';
import { RowCheckbox, SelectionBar, useSelection } from './ListManage.jsx';

const pulse = keyframes`0% { box-shadow: 0 0 0 0 rgba(46,160,67,.6); } 70% { box-shadow: 0 0 0 6px rgba(46,160,67,0); } 100% { box-shadow: 0 0 0 0 rgba(46,160,67,0); }`;
export const RunningDot = () => <Box component="span" role="img" aria-label="Running" title="Running" data-testid="running-dot" sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'success.main', flexShrink: 0, animation: `${pulse} 1.5s infinite`, '@media (prefers-reduced-motion: reduce)': { animation: 'none' } }} />;

export function timeAgo(sec, now = Date.now()) {
  const d = Math.max(0, Math.round(now / 1000 - sec));
  if (d < 45) return 'just now'; if (d < 3600) return `${Math.round(d / 60)} min ago`; if (d < 86400) return `${Math.round(d / 3600)} h ago`; if (d < 604800) return `${Math.round(d / 86400)} d ago`;
  return new Date(sec * 1000).toLocaleDateString();
}
const money = (n) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
const tokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);

// Every saved agent session for the project: start a new one, or open one and carry on.
export default function SessionsPanel({ project }) {
  const pid = project?.id;
  const live = useSession(pid);
  const [warn, setWarn] = useState(false); const [list, setList] = useState([]); const [menu, setMenu] = useState(null); const [rename, setRename] = useState(null); const [err, setErr] = useState('');
  const load = useCallback(() => (pid ? get(`/api/sessions?projectId=${pid}`).then(setList).catch(() => setList([])) : setList([])), [pid]);
  useEffect(() => { load(); }, [load, live.convId, live.busy]);
  useEffect(() => { const o = [sessions.on('sessions_changed', load), sessions.on('turn_end', load)]; return () => o.forEach((f) => f()); }, [load]);

  const selection = useSelection(list.map((c) => c.id));
  // Running sessions are kept by the server and reported back, so say so rather than letting them look deleted.
  const removeMany = async (opts) => { const r = await sessions.removeMany(pid, opts); setErr(r.skipped ? `${r.skipped} running session${r.skipped === 1 ? ' was' : 's were'} not deleted.` : ''); load(); };
  const open = async (id) => { setErr(''); try { await sessions.open(pid, id); } catch { setErr('Could not open that session.'); } };
  const remove = async (c) => { setMenu(null); if (!window.confirm(`Delete the session “${c.title}”? This cannot be undone.`)) return; try { await sessions.remove(pid, c.id); } catch (e) { setErr(e.body?.error === 'session_busy' ? 'That session is running right now.' : 'Could not delete the session.'); } load(); };
  if (!project) return <Box sx={{ p: 2 }}><Typography variant="body2" color="text.secondary">Select a project to see its sessions.</Typography></Box>;
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ p: 1 }}><Button fullWidth size="small" variant="outlined" startIcon={<AddIcon />} onClick={() => (live.busy || list.some((c) => c.running) || sessions.backgroundIds().length ? setWarn(true) : sessions.newSession(pid))}>New session</Button></Box>
      {err && <Typography variant="caption" color="error" sx={{ px: 1.5 }}>{err}</Typography>}
      <SelectionBar selection={selection} ids={list.map((c) => c.id)} noun="session" onDelete={(ids) => removeMany({ ids })} onDeleteAll={() => removeMany({ all: true })} />
      <List dense disablePadding sx={{ overflow: 'auto', flexGrow: 1 }} aria-label="Sessions">
        {live.convId === null && <ListItemButton selected dense data-testid="session-new"><ListItemText primary="New session" secondary={live.busy ? 'Starting…' : 'Not saved until you send a message'} primaryTypographyProps={{ fontStyle: 'italic' }} /></ListItemButton>}
        {list.map((c) => {
          const active = live.convId === c.id, running = c.running || (active && live.busy) || sessions.backgroundIds().includes(c.id);
          return (
            <ListItemButton key={c.id} dense selected={active} data-testid={`session-${c.id}`} disabled={!selection.selecting && live.busy && !active} onClick={() => (selection.selecting ? selection.toggle(c.id) : !active && open(c.id))} sx={{ pr: 5 }}>
              {selection.selecting && <RowCheckbox selection={selection} id={c.id} label={c.title} />}
              <ListItemText primary={<Stack direction="row" spacing={0.5} alignItems="center"><Typography variant="body2" noWrap sx={{ fontWeight: active ? 700 : 400, minWidth: 0 }}>{active && live.title ? live.title : c.title}</Typography>{running && <RunningDot />}</Stack>}
                secondary={<Stack component="span" direction="row" spacing={0.5} alignItems="center" flexWrap="wrap"><span>{timeAgo(c.updatedAt)}</span><Chip component="span" size="small" label={c.mode === 'act' ? 'Act' : 'Plan'} sx={{ height: 16, fontSize: 10 }} /><span>~{tokens(c.context.tokens)} tokens</span>{c.cost != null && <span data-testid="session-cost">· {money(c.cost)}</span>}{c.context.level !== 'ok' && <Chip component="span" size="small" color={c.context.level === 'high' ? 'warning' : 'default'} label={c.context.level === 'high' ? 'full' : 'long'} sx={{ height: 16, fontSize: 10 }} />}</Stack>} />
              {!selection.selecting && <Tooltip title="Session options"><IconButton size="small" aria-label={`Options for ${c.title}`} sx={{ position: 'absolute', right: 4 }} onClick={(e) => { e.stopPropagation(); setMenu({ anchor: e.currentTarget, c }); }}><MoreVertIcon fontSize="inherit" /></IconButton></Tooltip>}
            </ListItemButton>);
        })}
        {!list.length && live.convId !== null && <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>No other sessions yet.</Typography>}
      </List>
      <Menu anchorEl={menu?.anchor} open={!!menu} onClose={() => setMenu(null)} slotProps={{ list: { dense: true, 'aria-label': 'Session options' } }}>
        <MenuItem onClick={() => { setRename(menu.c); setMenu(null); }}>Rename…</MenuItem>
        <MenuItem onClick={() => remove(menu.c)}>Delete</MenuItem>
      </Menu>
      <Dialog open={warn} onClose={() => setWarn(false)} aria-labelledby="concurrent-title">
        <DialogTitle id="concurrent-title">An agent is still running</DialogTitle>
        <DialogContent><DialogContentText>Starting a second session while an agent is currently running may cause overwrites, because both can change the same project files. The running session keeps going in the background.</DialogContentText></DialogContent>
        <DialogActions><Button onClick={() => setWarn(false)}>Cancel</Button><Button color="warning" variant="contained" onClick={() => { setWarn(false); sessions.newSession(pid); }}>Start new session anyway</Button></DialogActions>
      </Dialog>
      {rename && <PromptDialog title="Rename session" label="Name" initial={rename.title} okLabel="Rename" onClose={() => setRename(null)} onOk={async (v) => { const c = rename; setRename(null); await sessions.rename(pid, c.id, v).catch(() => setErr('Could not rename the session.')); load(); }} />}
    </Box>
  );
}
