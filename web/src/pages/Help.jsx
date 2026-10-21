import { useMemo, useState } from 'react';
import { Box, Button, InputAdornment, List, ListItemButton, ListItemText, ListSubheader, Paper, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import ContactFooter from '../components/ContactFooter.jsx';
import Markdown from '../components/Markdown.jsx';
import { visibleTopics, groupsOf, bodyOf, linkVisible, matches } from '../help/visible.js';

// Documentation that adapts to the reader: each topic lists the permissions it needs, so people see help for what their role can do.
export default function Help() {
  const { user, can } = useAuth();
  const { topic: topicId } = useParams();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const ctx = useMemo(() => ({ permissions: user?.permissions || [], roles: user?.roles || [] }), [user]);
  const topics = useMemo(() => visibleTopics(can), [can]);
  const ids = useMemo(() => new Set(topics.map((t) => t.id)), [topics]);
  const found = useMemo(() => (q.trim() ? topics.filter((t) => matches(t, q, bodyOf(t, ctx))) : topics), [q, topics, ctx]);
  const current = topics.find((t) => t.id === topicId) || topics[0];
  const i = topics.findIndex((t) => t.id === current?.id);
  const open = (e) => { // links between topics navigate inside the page
    const a = e.target.closest?.('a[href^="#"]'); if (!a) return;
    e.preventDefault(); const id = a.getAttribute('href').slice(1); if (ids.has(id)) navigate(`/help/${id}`);
  };
  if (!current) return <Box sx={{ p: 3 }}><Typography>No help is available for your role yet.</Typography></Box>;

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '280px minmax(0, 1fr)' }, gridTemplateRows: { md: 'minmax(0, 1fr)' }, height: { md: '100%' }, minHeight: { xs: '100%', md: 0 } }}>
      <Box component="nav" aria-label="Help topics" sx={{ borderRight: { md: 1 }, borderBottom: { xs: 1, md: 0 }, borderColor: 'divider', p: 1.5, overflow: { md: 'auto' } }}>
        <TextField fullWidth size="small" placeholder="Search help" value={q} onChange={(e) => setQ(e.target.value)} slotProps={{ htmlInput: { 'aria-label': 'Search help' }, input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }} sx={{ mb: 1 }} />
        {!found.length && <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>No topics match “{q}”.</Typography>}
        {groupsOf(found).map(({ group, topics: ts }) => (
          <List key={group} dense disablePadding subheader={<ListSubheader disableSticky sx={{ lineHeight: '28px', bgcolor: 'transparent' }}>{group}</ListSubheader>}>
            {ts.map((t) => <ListItemButton key={t.id} component={RouterLink} to={`/help/${t.id}`} selected={t.id === current.id} sx={{ pl: 3 }}><ListItemText primary={t.title} /></ListItemButton>)}
          </List>))}
      </Box>
      <Box component="main" sx={{ overflow: { md: 'auto' }, display: 'flex', flexDirection: 'column' }} onClick={open}>
      <Box sx={{ p: { xs: 2, md: 4 }, maxWidth: 820, width: '100%' }}>
        <Typography variant="overline" color="text.secondary">{current.group}</Typography>
        <Typography variant="h4" component="h1" gutterBottom>{current.title}</Typography>
        <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}><Markdown docs>{linkVisible(bodyOf(current, ctx), ids)}</Markdown></Paper>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 2 }}>
          {i > 0 ? <Button component={RouterLink} to={`/help/${topics[i - 1].id}`}>← {topics[i - 1].title}</Button> : <span />}
          {i < topics.length - 1 ? <Button component={RouterLink} to={`/help/${topics[i + 1].id}`}>{topics[i + 1].title} →</Button> : <span />}
        </Box>
      </Box>
      <Box sx={{ px: { xs: 2, md: 4 }, pb: 1, maxWidth: 820, width: '100%', mt: 'auto', display: 'flex', flexDirection: 'column' }}><ContactFooter /></Box>
      </Box>
    </Box>
  );
}
