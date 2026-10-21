import { useState } from 'react';
import { Button, Divider, ListItemIcon, ListItemText, ListSubheader, Menu, MenuItem, Typography } from '@mui/material';
import ViewQuiltIcon from '@mui/icons-material/ViewQuiltOutlined';
import CheckIcon from '@mui/icons-material/Check';
import { layoutStore, useLayout } from '../layoutStore.js';
import { PRESETS, HIDEABLE, PANE_TITLES, visiblePanes } from './ide/layout.js';

// Lives in the app header (not in the editor) so people can always find it: ready-made arrangements, show/hide panels, reset.
export default function LayoutMenu() {
  const [layout] = useLayout();
  const [anchor, setAnchor] = useState(null);
  const shown = visiblePanes(layout), close = () => setAnchor(null);
  return (
    <>
      <Button data-tour="layout-menu" color="inherit" variant="outlined" size="small" startIcon={<ViewQuiltIcon />} aria-haspopup="menu" aria-expanded={!!anchor} onClick={(e) => setAnchor(e.currentTarget)}
        sx={{ mr: 1.5, textTransform: 'none', borderColor: 'rgba(255,255,255,.5)' }}>Layout</Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={close} slotProps={{ list: { dense: true, 'aria-label': 'Layout' }, paper: { sx: { minWidth: 280 } } }}>
        <ListSubheader sx={{ lineHeight: '30px' }}>Arrangements</ListSubheader>
        {Object.entries(PRESETS).map(([key, p]) => <MenuItem key={key} onClick={() => { close(); layoutStore.preset(key); }}><ListItemText>{p.label}</ListItemText></MenuItem>)}
        <Divider />
        <ListSubheader sx={{ lineHeight: '30px' }}>Panels</ListSubheader>
        {HIDEABLE.map((p) => (
          <MenuItem key={p} role="menuitemcheckbox" aria-checked={shown.includes(p)} onClick={() => layoutStore.toggle(p)}>
            <ListItemIcon sx={{ minWidth: 28 }}>{shown.includes(p) ? <CheckIcon fontSize="small" /> : null}</ListItemIcon><ListItemText>{PANE_TITLES[p]}</ListItemText>
          </MenuItem>))}
        <Divider />
        <MenuItem onClick={() => { close(); layoutStore.reset(); }}><ListItemText>Reset layout</ListItemText></MenuItem>
        <Typography variant="caption" color="text.secondary" component="p" sx={{ px: 2, pt: 0.5, pb: 1, maxWidth: 280 }}>Tip: drag a panel by its header to move it, and drag the dividers to resize.</Typography>
      </Menu>
    </>
  );
}
