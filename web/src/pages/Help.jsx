import { useMemo, useState } from 'react';
import { Box, Breadcrumbs, Button, InputAdornment, Link, List, ListItemButton, ListItemText, ListSubheader, Paper, TextField, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import ContactFooter from '../components/ContactFooter.jsx';
import Markdown from '../components/Markdown.jsx';
import { visibleTopics, groupsOf, bodyOf, linkVisible, matches } from '../help/visible.js';

const PREVIEW = 5; // categories with more articles than this show "Show more"

function SearchBox({ value, onChange, sx }) {
  return <TextField fullWidth size="small" placeholder="Search help" value={value} onChange={(e) => onChange(e.target.value)} slotProps={{ htmlInput: { 'aria-label': 'Search help' }, input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }} sx={sx} />;
}

// The default view: every category with its articles as a list. Long categories show a few articles until "Show more" is chosen.
function ArticleIndex({ q, setQ, groups, searching, expanded, onToggle }) {
  return (
    <Box sx={{ p: { xs: 2, md: 4 }, width: '100%' }}>
      <Typography variant="h4" component="h1" gutterBottom>Help</Typography>
      <Typography color="text.secondary" sx={{ mb: 2 }}>Choose an article to read, or search for one below.</Typography>
      <SearchBox value={q} onChange={setQ} sx={{ mb: 3 }} />
      {!groups.length && <Typography color="text.secondary" sx={{ mb: 2 }}>No topics match “{q}”.</Typography>}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }, gap: 3, alignItems: 'start' }}>
        {groups.map(({ group, topics: ts }) => {
          const open = searching || !!expanded[group];
          const shown = open ? ts : ts.slice(0, PREVIEW);
          return (
            <Box key={group} sx={{ minWidth: 0 }}>
              <Typography variant="h6" component="h2" sx={{ fontSize: '1.05rem', mb: 1 }}>{group}</Typography>
              <Paper variant="outlined">
                <List disablePadding>
                  {shown.map((t) => <ListItemButton key={t.id} component={RouterLink} to={`/help/${t.id}`}><ListItemText primary={t.title} /></ListItemButton>)}
                </List>
              </Paper>
              {!searching && ts.length > PREVIEW && (
                <Button size="small" onClick={() => onToggle(group)} sx={{ mt: 1 }}>
                  {open ? 'Show fewer' : `Show more (${ts.length - PREVIEW} more)`}
                </Button>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

// Documentation that adapts to the reader: each topic lists the permissions it needs, so people see help for what their role can do.
export default function Help() {
  const { user, can } = useAuth();
  const { topic: topicId } = useParams();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState({});
  const ctx = useMemo(() => ({ permissions: user?.permissions || [], roles: user?.roles || [] }), [user]);
  const topics = useMemo(() => visibleTopics(can), [can]);
  const ids = useMemo(() => new Set(topics.map((t) => t.id)), [topics]);
  const searching = !!q.trim();
  const found = useMemo(() => (searching ? topics.filter((t) => matches(t, q, bodyOf(t, ctx))) : topics), [q, topics, ctx, searching]);
  const groups = useMemo(() => groupsOf(found), [found]);
  const current = topicId ? (topics.find((t) => t.id === topicId) || topics[0]) : null; // no topic in the address: show the index
  const i = topics.findIndex((t) => t.id === current?.id);
  const open = (e) => { // links between topics navigate inside the page
    const a = e.target.closest?.('a[href^="#"]'); if (!a) return;
    e.preventDefault(); const id = a.getAttribute('href').slice(1); if (ids.has(id)) navigate(`/help/${id}`);
  };
  const toggle = (group) => setExpanded((e) => ({ ...e, [group]: !e[group] }));
  if (!topics.length) return <Box sx={{ p: 3 }}><Typography>No help is available for your role yet.</Typography></Box>;

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: current ? { xs: '1fr', md: '280px minmax(0, 1fr)' } : '1fr', gridTemplateRows: { md: 'minmax(0, 1fr)' }, height: { md: '100%' }, minHeight: { xs: '100%', md: 0 } }}>
      {current && (
        <Box component="nav" aria-label="Help topics" sx={{ borderRight: { md: 1 }, borderBottom: { xs: 1, md: 0 }, borderColor: 'divider', p: 1.5, overflow: { md: 'auto' } }}>
          <SearchBox value={q} onChange={setQ} sx={{ mb: 1 }} />
          {!found.length && <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>No topics match “{q}”.</Typography>}
          {groups.map(({ group, topics: ts }) => (
            <List key={group} dense disablePadding subheader={<ListSubheader disableSticky sx={{ lineHeight: '28px', bgcolor: 'transparent' }}>{group}</ListSubheader>}>
              {ts.map((t) => <ListItemButton key={t.id} component={RouterLink} to={`/help/${t.id}`} selected={t.id === current.id} sx={{ pl: 3 }}><ListItemText primary={t.title} /></ListItemButton>)}
            </List>))}
        </Box>
      )}
      <Box component="main" sx={{ overflow: { md: 'auto' }, display: 'flex', flexDirection: 'column' }} onClick={open}>
        <Box sx={{ px: { xs: 2, md: 4 }, pt: { xs: 2, md: 3 }, maxWidth: 820, width: '100%' }}>
          <Breadcrumbs aria-label="breadcrumb">
            {current ? <Link component={RouterLink} to="/help" underline="hover" color="inherit">Help</Link> : <Typography color="text.primary">Help</Typography>}
            {current && <Typography color="text.secondary">{current.group}</Typography>}
            {current && <Typography color="text.primary">{current.title}</Typography>}
          </Breadcrumbs>
        </Box>
        {current ? (
          <Box sx={{ p: { xs: 2, md: 4 }, pt: { xs: 2, md: 2 }, maxWidth: 820, width: '100%' }}>
            <Typography variant="overline" color="text.secondary">{current.group}</Typography>
            <Typography variant="h4" component="h1" gutterBottom>{current.title}</Typography>
            <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}><Markdown docs>{linkVisible(bodyOf(current, ctx), ids)}</Markdown></Paper>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 2 }}>
              {i > 0 ? <Button component={RouterLink} to={`/help/${topics[i - 1].id}`}>← {topics[i - 1].title}</Button> : <span />}
              {i < topics.length - 1 ? <Button component={RouterLink} to={`/help/${topics[i + 1].id}`}>{topics[i + 1].title} →</Button> : <span />}
            </Box>
          </Box>
        ) : <ArticleIndex q={q} setQ={setQ} groups={groups} searching={searching} expanded={expanded} onToggle={toggle} />}
        <Box sx={{ px: { xs: 2, md: 4 }, pb: 1, maxWidth: 820, width: '100%', mt: 'auto', display: 'flex', flexDirection: 'column' }}><ContactFooter /></Box>
      </Box>
    </Box>
  );
}
