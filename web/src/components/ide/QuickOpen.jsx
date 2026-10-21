import { useEffect, useMemo, useState } from 'react';
import { Dialog, InputBase, List, ListItemButton, ListItemText, Box, Typography } from '@mui/material';
import { baseName, dirName } from '../pathUtils.js';

// Files in the tree, flattened to paths.
export const flattenFiles = (tree, out = []) => { for (const n of tree) { if (n.type === 'dir') flattenFiles(n.children || [], out); else out.push(n.path); } return out; };

// Fuzzy match: every query character must appear in order. Lower is better; null is no match. Matches in the file name beat
// matches in the folder part, and consecutive characters beat scattered ones.
export function fuzzyScore(path, query) {
  const p = path.toLowerCase(), q = query.toLowerCase().replace(/\s+/g, ''); if (!q) return 0;
  const nameStart = p.length - baseName(p).length;
  let score = 0, at = -1;
  for (const ch of q) {
    const i = p.indexOf(ch, at + 1); if (i < 0) return null;
    score += i === at + 1 ? 0 : 3 + (i - at - 1) * 0.1; // a gap costs more than a long file
    if (i < nameStart) score += 1;
    at = i;
  }
  const exact = baseName(p).includes(q) ? -10 : 0;
  return score + exact + p.length * 0.01;
}
export const rankFiles = (paths, query, limit = 50) => paths.map((p) => [p, fuzzyScore(p, query)]).filter(([, s]) => s !== null).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([p]) => p);

// "Go to File…": type to filter the project's files, Enter opens the highlighted one.
export default function QuickOpen({ files, recent = [], onOpen, onClose }) {
  const [q, setQ] = useState(''); const [sel, setSel] = useState(0);
  const shown = useMemo(() => (q.trim() ? rankFiles(files, q) : [...recent.filter((p) => files.includes(p)), ...files.filter((p) => !recent.includes(p))].slice(0, 50)), [files, recent, q]);
  useEffect(() => setSel(0), [q]);
  const pick = (p) => { if (p) { onClose(); onOpen(p); } };
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(shown[sel]); }
  };
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" aria-label="Go to file" slotProps={{ paper: { sx: { position: 'absolute', top: '10%', m: 0, width: 'min(600px, 92vw)' } } }}>
      <Box sx={{ px: 2, py: 1, borderBottom: 1, borderColor: 'divider' }}>
        <InputBase autoFocus fullWidth placeholder="Search files by name" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key}
          inputProps={{ 'aria-label': 'Go to file', role: 'combobox', 'aria-expanded': true, 'aria-controls': 'quick-open-list', 'aria-activedescendant': shown[sel] ? `qo-${sel}` : undefined }} />
      </Box>
      <List dense id="quick-open-list" role="listbox" sx={{ maxHeight: 360, overflow: 'auto', py: 0 }}>
        {shown.map((p, i) => (
          <ListItemButton key={p} id={`qo-${i}`} role="option" aria-selected={i === sel} selected={i === sel} onMouseMove={() => setSel(i)} onClick={() => pick(p)}>
            <ListItemText primary={baseName(p)} secondary={dirName(p) || null} slotProps={{ primary: { noWrap: true }, secondary: { noWrap: true } }} />
          </ListItemButton>
        ))}
        {!shown.length && <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>{files.length ? 'No matching files' : 'This project has no files'}</Typography>}
      </List>
    </Dialog>
  );
}
