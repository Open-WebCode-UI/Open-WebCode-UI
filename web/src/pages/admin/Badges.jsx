import { useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Paper, Stack, Typography } from '@mui/material';
import DeleteIcon from '@mui/icons-material/DeleteOutlined';
import ArrowUpIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownIcon from '@mui/icons-material/ArrowDownward';
import { post, put, del } from '../../api.js';
import { BadgeChip, BADGE_COLORS } from '../../components/ModelBadges.jsx';
import { Text, Pick, errText } from './common.jsx';

// Create, edit, order and delete badge categories and badges. Badges are attached to models in the model's own dialog.
export default function BadgesDialog({ data, onClose, reload }) {
  const [msg, setMsg] = useState(null);
  const [catName, setCatName] = useState('');
  const [editCat, setEditCat] = useState(null); // { id, name }
  const [editBadge, setEditBadge] = useState(null); // badge being created/edited
  const act = async (fn) => { setMsg(null); try { await fn(); await reload(); return true; } catch (e) { setMsg(e.body?.message || errText(e)); return false; } };
  // Swaps item i with its neighbour d steps away within `items` (a category's badges, or all categories); the list saved is the full order.
  const move = (url, all, items, i, d) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const ids = all.map((x) => x.id), a = ids.indexOf(items[i].id), b = ids.indexOf(items[j].id);
    [ids[a], ids[b]] = [ids[b], ids[a]];
    return act(() => put(url, { ids }));
  };
  const groups = [...data.categories.map((c) => ({ c, items: data.badges.filter((b) => b.categoryId === c.id) })), { c: null, items: data.badges.filter((b) => b.categoryId == null) }];

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md" scroll="paper" aria-labelledby="badges-title">
      <DialogTitle id="badges-title">Badges<Typography variant="body2" color="text.secondary" component="div">Short labels shown on a model's card in the model picker, such as the data classification it is approved for or what it is good at. Add them to a model by editing the model.</Typography></DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {msg && !editCat && !editBadge && <Alert severity="error" onClose={() => setMsg(null)}>{msg}</Alert>}
          <Stack direction="row" spacing={1}>
            <Text label="New category" value={catName} onChange={setCatName} placeholder="Data classification, Good at, ..." slotProps={{ htmlInput: { maxLength: 60 } }} />
            <Button disabled={!catName.trim()} onClick={async () => { if (await act(() => post('/api/admin/badge-categories', { name: catName }))) setCatName(''); }}>Add</Button>
          </Stack>
          {groups.filter((g) => g.c || g.items.length).map(({ c, items }, gi) => (
            <Paper key={c?.id ?? 'none'} variant="outlined" sx={{ p: 1.5 }} component="section" aria-label={c ? `Category ${c.name}` : 'Uncategorized'}>
              <Stack direction="row" alignItems="center" spacing={0.5}>
                {c && <><IconButton size="small" aria-label={`Move ${c.name} up`} disabled={gi === 0} onClick={() => move('/api/admin/badge-categories/order', data.categories, data.categories, gi, -1)}><ArrowUpIcon fontSize="inherit" /></IconButton>
                  <IconButton size="small" aria-label={`Move ${c.name} down`} disabled={gi === data.categories.length - 1} onClick={() => move('/api/admin/badge-categories/order', data.categories, data.categories, gi, 1)}><ArrowDownIcon fontSize="inherit" /></IconButton></>}
                <Typography variant="subtitle1" component="h3" sx={{ flexGrow: 1 }}>{c ? c.name : 'Uncategorized'}</Typography>
                {c && <Button size="small" aria-label={`Rename ${c.name}`} onClick={() => { setMsg(null); setEditCat({ ...c }); }}>Rename</Button>}
                {c && <Button size="small" color="error" aria-label={`Delete category ${c.name}`} onClick={() => { if (window.confirm(`Delete the category "${c.name}"? Its badges are kept, uncategorized.`)) act(() => del(`/api/admin/badge-categories/${c.id}`)); }}>Delete</Button>}
                <Button size="small" aria-label={`Add badge to ${c ? c.name : 'uncategorized'}`} onClick={() => { setMsg(null); setEditBadge({ label: '', description: '', color: 'gray', categoryId: c?.id ?? null }); }}>Add badge</Button>
              </Stack>
              {!items.length && <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>No badges yet.</Typography>}
              {items.map((b, i) => (
                <Stack key={b.id} direction="row" alignItems="center" spacing={1} sx={{ mt: 0.5 }}>
                  <IconButton size="small" aria-label={`Move ${b.label} up`} disabled={i === 0} onClick={() => move('/api/admin/badges/order', data.badges, items, i, -1)}><ArrowUpIcon fontSize="inherit" /></IconButton>
                  <IconButton size="small" aria-label={`Move ${b.label} down`} disabled={i === items.length - 1} onClick={() => move('/api/admin/badges/order', data.badges, items, i, 1)}><ArrowDownIcon fontSize="inherit" /></IconButton>
                  <BadgeChip badge={b} category={null} />
                  <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>{b.description}</Typography>
                  <Button size="small" aria-label={`Edit ${b.label}`} onClick={() => { setMsg(null); setEditBadge({ ...b }); }}>Edit</Button>
                  <IconButton size="small" aria-label={`Delete ${b.label}`} onClick={() => { if (window.confirm(`Delete the badge "${b.label}"? It is removed from every model.`)) act(() => del(`/api/admin/badges/${b.id}`)); }}><DeleteIcon fontSize="inherit" /></IconButton>
                </Stack>))}
            </Paper>))}
          {!data.categories.length && !data.badges.length && <Typography color="text.secondary">No badges yet. Add a category, then add badges to it.</Typography>}
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Done</Button></DialogActions>

      {editCat && (
        <Dialog open onClose={() => setEditCat(null)} fullWidth maxWidth="xs" aria-labelledby="cat-title">
          <DialogTitle id="cat-title">Rename category</DialogTitle>
          <DialogContent><Box sx={{ pt: 1 }}>{msg && <Alert severity="error" sx={{ mb: 2 }}>{msg}</Alert>}<Text label="Name" value={editCat.name} onChange={(v) => setEditCat({ ...editCat, name: v })} slotProps={{ htmlInput: { maxLength: 60 } }} /></Box></DialogContent>
          <DialogActions><Button onClick={() => setEditCat(null)}>Cancel</Button><Button variant="contained" disabled={!editCat.name.trim()} onClick={async () => { if (await act(() => put(`/api/admin/badge-categories/${editCat.id}`, { name: editCat.name }))) setEditCat(null); }}>Save</Button></DialogActions>
        </Dialog>)}
      {editBadge && <BadgeForm init={editBadge} categories={data.categories} onClose={() => setEditBadge(null)} act={act} msg={msg} />}
    </Dialog>
  );
}

function BadgeForm({ init, categories, onClose, act, msg }) {
  const [f, setF] = useState(init);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const body = { label: f.label, description: f.description, color: f.color, categoryId: f.categoryId };
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs" aria-labelledby="badge-title">
      <DialogTitle id="badge-title">{init.id ? 'Edit badge' : 'Add badge'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {msg && <Alert severity="error">{msg}</Alert>}
          <Text label="Label" value={f.label} onChange={set('label')} slotProps={{ htmlInput: { maxLength: 40 } }} helperText="Keep it short, e.g. “Tier 2” or “Coding”." />
          <Text label="Description (optional)" multiline minRows={2} value={f.description} onChange={set('description')} slotProps={{ htmlInput: { maxLength: 300 } }} helperText={`Shown when a user hovers over the badge. ${f.description.length}/300`} />
          <Pick label="Category" value={f.categoryId ?? 'none'} onChange={(v) => set('categoryId')(v === 'none' ? null : v)} options={[['none', 'Uncategorized'], ...categories.map((c) => [c.id, c.name])]} />
          <Pick label="Color" value={f.color} onChange={set('color')} options={Object.entries(BADGE_COLORS).map(([k, v]) => [k, v.name])} helperText="Color is not the only cue: the label is always shown." />
          <Box><Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>Preview</Typography><BadgeChip badge={{ ...f, label: f.label || 'Label' }} category={null} /></Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!f.label.trim()} onClick={async () => { if (await act(() => (init.id ? put(`/api/admin/badges/${init.id}`, body) : post('/api/admin/badges', body)))) onClose(); }}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}
