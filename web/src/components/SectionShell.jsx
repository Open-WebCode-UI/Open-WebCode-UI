import { Box, List, ListItemButton, ListItemText, ListSubheader } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import ContactFooter from './ContactFooter.jsx';

// The page frame shared by Profile and Admin: a section list on the left, and the section itself in one content column
// of a fixed maximum width, so every section lines up the same way and its cards fill the column.
export const CONTENT_MAX_WIDTH = 1000;

export default function SectionShell({ ariaLabel, items, tour, contact, children }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '240px minmax(0,1fr)', gridTemplateRows: 'minmax(0,1fr)', height: '100%' }}>
      <Box component="nav" aria-label={ariaLabel} {...(tour ? { 'data-tour': tour } : {})} sx={{ borderRight: 1, borderColor: 'divider', overflow: 'auto', minHeight: 0 }}>
        <List>{items.map((i) => (i.heading
          ? <ListSubheader key={i.key} component="div" sx={{ lineHeight: '32px', mt: 1, bgcolor: 'transparent' }}>{i.label}</ListSubheader> // a group title, such as a course module
          : <ListItemButton key={i.to} component={RouterLink} to={i.to} selected={i.selected} sx={i.indent ? { pl: 4 } : undefined}><ListItemText primary={i.label} /></ListItemButton>))}</List>
      </Box>
      <Box sx={{ p: 3, overflow: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}><Box sx={{ maxWidth: CONTENT_MAX_WIDTH, width: '100%' }}>{children}</Box>{contact && <Box sx={{ maxWidth: CONTENT_MAX_WIDTH, width: '100%', mt: 'auto', display: 'flex', flexDirection: 'column' }}><ContactFooter /></Box>}</Box>
    </Box>
  );
}
