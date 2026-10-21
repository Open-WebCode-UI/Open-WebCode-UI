import { useEffect, useState, useCallback } from 'react';
import { Box, Typography, Button, Table, TableHead, TableRow, TableCell, TableBody, Chip, Dialog, DialogTitle, DialogContent, DialogActions, Stack, Alert, Autocomplete, TextField, FormControlLabel, Switch, Paper, Tabs, Tab, Checkbox, FormGroup } from '@mui/material';
import { get, post, put, del } from '../../api.js';
import { useAuth } from '../../AuthContext.jsx';
import { useStepUp } from '../../components/StepUp.jsx';
import { errText } from './common.jsx';

export default function Users() {
  const { can, user: me } = useAuth(); const write = can('user.write');
  const [tab, setTab] = useState('users');
  return (
    <Box>
      <Typography variant="h5" gutterBottom>Users &amp; roles</Typography>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}><Tab value="users" label="Users" />{can('role.read') && <Tab value="roles" label="Roles" />}</Tabs>
      {tab === 'users' ? <UserTable write={write} meId={me.id} /> : <Roles />}
    </Box>
  );
}

function UserTable({ write, meId }) {
  const { can } = useAuth();
  const { run, dialog } = useStepUp();
  const [users, setUsers] = useState([]); const [roles, setRoles] = useState([]); const [edit, setEdit] = useState(null); const [msg, setMsg] = useState(null);
  const load = useCallback(() => { get('/api/admin/users').then(setUsers); get('/api/admin/roles').then((r) => setRoles(r.roles.map((x) => x.name))).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (fn, ok) => { try { await run(fn); setMsg(ok ? { s: 'success', t: ok } : null); load(); } catch (e) { if (e.message !== 'canceled') setMsg({ s: 'error', t: errText(e) }); } };
  return (
    <>
      {msg && <Alert severity={msg.s} sx={{ mb: 2 }} onClose={() => setMsg(null)}>{msg.t}</Alert>}
      <Alert severity="info" sx={{ mb: 2 }}>Most people sign in through SSO and appear here automatically. Local accounts are intended for break-glass use and always require MFA.</Alert>
      {write && <Button variant="contained" sx={{ mb: 2 }} onClick={() => setEdit({ username: '', password: '', roles: [], isBreakGlass: true })}>Add local user</Button>}
      <Table size="small">
        <TableHead><TableRow><TableCell>Name</TableCell><TableCell>Email / username</TableCell><TableCell>Source</TableCell><TableCell>Roles</TableCell><TableCell>MFA</TableCell><TableCell>Last login</TableCell><TableCell /></TableRow></TableHead>
        <TableBody>{users.map((u) => (
          <TableRow key={u.id} sx={{ opacity: u.disabled ? 0.5 : 1 }}>
            <TableCell>{u.displayName}</TableCell>
            <TableCell>{u.email || u.username}</TableCell>
            <TableCell><Chip size="small" label={u.source === 'saml' ? 'SSO' : u.isBreakGlass ? 'Break-glass' : 'Local'} /></TableCell>
            <TableCell>{u.roles.map((r) => <Chip key={r} size="small" label={r} sx={{ mr: 0.5 }} />)}</TableCell>
            <TableCell>{u.source === 'local' ? (u.mfaEnrolled ? 'Enrolled' : 'Not enrolled') : 'IdP'}</TableCell>
            <TableCell>{u.lastLogin ? new Date(u.lastLogin * 1000).toLocaleString() : '—'}</TableCell>
            <TableCell align="right">{write && <>
              <Button size="small" onClick={() => setEdit({ ...u })}>Edit</Button>
              {can('course.admin') && <Button size="small" onClick={() => act(() => put(`/api/admin/instructors/${u.id}`, { instructor: !u.roles.includes('instructor') }), u.roles.includes('instructor') ? 'Instructor removed' : 'Instructor designated')}>{u.roles.includes('instructor') ? 'Remove instructor' : 'Make instructor'}</Button>}
              {u.source === 'local' && can2('mfa.reset') && <Button size="small" onClick={() => act(() => post(`/api/admin/users/${u.id}/reset-mfa`), 'MFA reset')}>Reset MFA</Button>}
              {u.id !== meId && <Button size="small" color="error" onClick={() => window.confirm(`Delete ${u.displayName}?`) && act(() => del(`/api/admin/users/${u.id}`), 'User deleted')}>Delete</Button>}</>}</TableCell>
          </TableRow>))}</TableBody>
      </Table>
      {edit && <UserDialog init={edit} roles={roles} onClose={() => setEdit(null)} onSave={(body, id) => act(() => (id ? put(`/api/admin/users/${id}`, body) : post('/api/admin/users', body)), 'Saved').then(() => setEdit(null))} />}
      {dialog}
    </>
  );
}
const can2 = () => true; // server enforces mfa.reset; button failure is reported

function UserDialog({ init, roles, onClose, onSave }) {
  const isNew = !init.id; const saml = init.source === 'saml';
  const [f, setF] = useState({ ...init, password: '' });
  const body = isNew ? { username: f.username, password: f.password, email: f.email || '', firstName: f.firstName || '', lastName: f.lastName || '', roles: f.roles, isBreakGlass: f.isBreakGlass, mustChange: true }
    : { email: f.email, firstName: f.firstName, lastName: f.lastName, roles: f.roles, disabled: f.disabled, ...(saml ? {} : { isBreakGlass: f.isBreakGlass, ...(f.password ? { password: f.password } : {}) }) };
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{isNew ? 'Add local user' : `Edit ${init.displayName}`}</DialogTitle>
      <DialogContent><Stack spacing={2} sx={{ mt: 1 }}>
        {isNew && <TextField size="small" label="Username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />}
        {!saml && <TextField size="small" type="password" autoComplete="new-password" label={isNew ? 'Initial password' : 'New password (optional)'} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} helperText="User must change it at first sign-in." />}
        <TextField size="small" label="Email" value={f.email || ''} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <Stack direction="row" spacing={1}><TextField size="small" fullWidth label="First name" value={f.firstName || ''} onChange={(e) => setF({ ...f, firstName: e.target.value })} /><TextField size="small" fullWidth label="Last name" value={f.lastName || ''} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></Stack>
        <Autocomplete multiple options={roles} value={f.roles || []} onChange={(_, v) => setF({ ...f, roles: v })} renderInput={(p) => <TextField {...p} size="small" label="Roles" />} />
        {!saml && <FormControlLabel control={<Switch checked={!!f.isBreakGlass} onChange={(e) => setF({ ...f, isBreakGlass: e.target.checked })} />} label="Break-glass account (allowed to use local sign-in)" />}
        {!isNew && <FormControlLabel control={<Switch checked={!!f.disabled} onChange={(e) => setF({ ...f, disabled: e.target.checked })} />} label="Disabled" />}
      </Stack></DialogContent>
      <DialogActions><Button onClick={onClose}>Cancel</Button><Button variant="contained" onClick={() => onSave(body, init.id)}>Save</Button></DialogActions>
    </Dialog>
  );
}

function Roles() {
  const { can } = useAuth(); const write = can('role.write');
  const { run, dialog } = useStepUp();
  const [data, setData] = useState({ roles: [] }); const [perms, setPerms] = useState({}); const [edit, setEdit] = useState(null); const [msg, setMsg] = useState(null);
  const load = useCallback(() => get('/api/admin/roles').then(setData), []);
  useEffect(() => { load(); get('/api/permissions').then(setPerms); }, [load]);
  const act = async (fn, ok) => { try { await run(fn); setMsg({ s: 'success', t: ok }); load(); } catch (e) { if (e.message !== 'canceled') setMsg({ s: 'error', t: errText(e) }); } };
  return (
    <>
      {msg && <Alert severity={msg.s} sx={{ mb: 2 }} onClose={() => setMsg(null)}>{msg.t}</Alert>}
      {write && <Button variant="contained" sx={{ mb: 2 }} onClick={() => setEdit({ name: '', description: '', permissions: [] })}>New role</Button>}
      {data.roles.map((r) => (
        <Paper key={r.id} variant="outlined" sx={{ p: 2, mb: 1 }}>
          <Stack direction="row" alignItems="center" spacing={1}><Typography sx={{ flexGrow: 1 }}><b>{r.name}</b> <Typography component="span" variant="body2" color="text.secondary">{r.description}</Typography></Typography>
            {r.builtin && <Chip size="small" label="built-in" />}
            {write && r.name !== 'administrator' && <Button size="small" onClick={() => setEdit(r)}>Edit</Button>}
            {write && !r.builtin && <Button size="small" color="error" onClick={() => act(() => del(`/api/admin/roles/${r.id}`), 'Role deleted')}>Delete</Button>}</Stack>
          <Typography variant="caption" color="text.secondary">{r.permissions.length} permission(s)</Typography>
        </Paper>))}
      {edit && <RoleDialog init={edit} perms={perms} onClose={() => setEdit(null)} onSave={(b) => act(() => (edit.id ? put(`/api/admin/roles/${edit.id}`, b) : post('/api/admin/roles', b)), 'Role saved').then(() => setEdit(null))} />}
      {dialog}
    </>
  );
}

function RoleDialog({ init, perms, onClose, onSave }) {
  const [f, setF] = useState(init);
  const toggle = (p) => setF({ ...f, permissions: f.permissions.includes(p) ? f.permissions.filter((x) => x !== p) : [...f.permissions, p] });
  const groups = Object.keys(perms).reduce((a, p) => { const g = p.split('.')[0]; (a[g] ||= []).push(p); return a; }, {});
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{init.id ? `Edit role ${init.name}` : 'New role'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField size="small" label="Name" disabled={init.builtin} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <TextField size="small" label="Description" value={f.description || ''} onChange={(e) => setF({ ...f, description: e.target.value })} />
          <Typography variant="subtitle2">Permissions (read and write are granted separately)</Typography>
          {Object.entries(groups).map(([g, list]) => (
            <Box key={g}><Typography variant="caption" sx={{ textTransform: 'uppercase' }}>{g}</Typography>
              <FormGroup row>{list.map((p) => <FormControlLabel key={p} control={<Checkbox size="small" checked={f.permissions.includes(p)} onChange={() => toggle(p)} />} label={<span title={perms[p]}>{p}</span>} />)}</FormGroup></Box>))}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Cancel</Button><Button variant="contained" disabled={!f.name} onClick={() => onSave({ name: f.name, description: f.description || '', permissions: f.permissions })}>Save</Button></DialogActions>
    </Dialog>
  );
}
