import { useEffect, useState } from 'react';
import { Alert, Box, Button, Card, CardActions, CardContent, LinearProgress, Stack, TextField, Typography } from '@mui/material';
import { Link as RouterLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { get, post } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import Player from './courses/Player.jsx';
import Author from './courses/Author.jsx';
import Assessment from './courses/Assessment.jsx';

function CourseList() {
  const { can } = useAuth(); const nav = useNavigate();
  const [mine, setMine] = useState(null); const [authored, setAuthored] = useState([]); const [title, setTitle] = useState(''); const [error, setError] = useState('');
  useEffect(() => {
    if (can('course.learn')) get('/api/courses').then(setMine).catch(() => setMine([])); else setMine([]);
    if (can('course.author')) get('/api/courses/authored').then(setAuthored).catch(() => {});
  }, [can]);
  const create = async () => {
    try { const c = await post('/api/courses', { title }); nav(`/courses/${c.id}/edit`); } catch (e) { setError(e.body?.error || 'failed'); }
  };
  return (
    <Box sx={{ p: 3, maxWidth: 1000, overflow: 'auto', height: '100%' }}>
      {can('course.learn') && (
        <>
          <Typography variant="h5" component="h1" gutterBottom>My courses</Typography>
          {mine && !mine.length && <Typography color="text.secondary">You are not enrolled in any courses yet.</Typography>}
          <Stack spacing={2}>
            {(mine || []).map((c) => (
              <Card key={c.id} variant="outlined">
                <CardContent>
                  <Typography variant="h6" component="h2">{c.title}</Typography>
                  <Typography color="text.secondary" sx={{ mb: 1 }}>{c.description}</Typography>
                  <LinearProgress variant="determinate" value={c.pages ? (100 * c.completed) / c.pages : 0} aria-label={`${c.completed} of ${c.pages} pages complete`} />
                  <Typography variant="caption">{c.completed} of {c.pages} pages complete</Typography>
                </CardContent>
                <CardActions><Button component={RouterLink} to={`/courses/${c.id}`}>{c.completed ? 'Continue' : 'Start'}</Button></CardActions>
              </Card>
            ))}
          </Stack>
        </>
      )}
      {can('course.author') && (
        <Box sx={{ mt: 4 }}>
          <Typography variant="h5" component="h2" gutterBottom>Courses I teach</Typography>
          {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
          <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
            <TextField size="small" label="New course title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <Button variant="contained" disabled={!title.trim()} onClick={create}>Create course</Button>
          </Stack>
          <Stack spacing={1}>
            {authored.map((c) => (
              <Stack key={c.id} direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                <Typography sx={{ flexGrow: 1 }}>{c.title} <Typography component="span" variant="caption" color="text.secondary">({c.status})</Typography></Typography>
                <Button component={RouterLink} to={`/courses/${c.id}/edit`} size="small">Edit</Button>
              </Stack>
            ))}
          </Stack>
        </Box>
      )}
    </Box>
  );
}

export default function Courses() {
  const { user, can } = useAuth();
  if (!user) return null;
  return (
    <Routes>
      <Route index element={<CourseList />} />
      <Route path=":id/edit" element={can('course.author') ? <Author /> : <Navigate to="/courses" replace />} />
      <Route path=":id/assessment/:aid" element={<Assessment />} />
      <Route path=":id/preview/:pid?" element={<Player preview />} />
      <Route path=":id/:pid?" element={<Player />} />
    </Routes>
  );
}
