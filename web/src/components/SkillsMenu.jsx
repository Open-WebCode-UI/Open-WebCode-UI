import { useEffect, useState } from 'react';
import { IconButton, Menu, MenuItem, ListItemText, Tooltip } from '@mui/material';
import AutoFixIcon from '@mui/icons-material/AutoFixHigh';
import { get } from '../api.js';

// Picker for the user's enabled skills on this page (scope 'agent' or 'chat'); inserts "/skill-name " at the start of the message box.
export default function SkillsMenu({ onPick, disabled, scope = 'agent' }) {
  const [skills, setSkills] = useState([]); const [anchor, setAnchor] = useState(null);
  useEffect(() => { get(`/api/skills?scope=${scope}`).then((l) => setSkills(l.filter((s) => s.enabled))).catch(() => {}); }, [scope]);
  return (
    <>
      <Tooltip title="Skills (or type /skill-name)"><span><IconButton aria-label="Skills" disabled={disabled} onClick={(e) => setAnchor(e.currentTarget)}><AutoFixIcon /></IconButton></span></Tooltip>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        {skills.map((s) => <MenuItem key={s.name} onClick={() => { setAnchor(null); onPick(`/${s.name} `); }}><ListItemText primary={`/${s.name}`} secondary={s.description} secondaryTypographyProps={{ sx: { maxWidth: 320, whiteSpace: 'normal' } }} /></MenuItem>)}
        <MenuItem key="status" onClick={() => { setAnchor(null); onPick('/status'); }}><ListItemText primary="/status" secondary="Connection, server, user, and project information" secondaryTypographyProps={{ sx: { maxWidth: 320, whiteSpace: 'normal' } }} /></MenuItem>
        {scope === 'agent' && <MenuItem key="clear" onClick={() => { setAnchor(null); onPick('/clear'); }}><ListItemText primary="/clear" secondary="Wipe the agent's memory of this session and start fresh" secondaryTypographyProps={{ sx: { maxWidth: 320, whiteSpace: 'normal' } }} /></MenuItem>}
      </Menu>
    </>
  );
}
