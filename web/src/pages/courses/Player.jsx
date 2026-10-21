import { useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Stack, Typography } from '@mui/material';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { get, post } from '../../api.js';
import SectionShell from '../../components/SectionShell.jsx';
import { RichView } from '../../components/RichText.jsx';
import { ChatPanel, FilePanel, TutorPanel } from './Panels.jsx';
import { AssessmentRunner } from './Assessment.jsx';

export default function Player({ preview = false }) {
  const { id, pid } = useParams(); const nav = useNavigate();
  const [course, setCourse] = useState(null); const [error, setError] = useState('');
  useEffect(() => {
    setCourse(null); get(`/api/courses/${id}`).then(setCourse).catch((e) => setError(e.body?.error || 'failed'));
  }, [id]);
  if (error) return <Box sx={{ p: 3 }}><Alert severity="error">{error === 'course_not_found' ? 'Course not found.' : `Could not load the course (${error}).`}</Alert></Box>;
  if (!course) return <Box sx={{ p: 3 }}><CircularProgress aria-label="Loading" /></Box>;

  const pages = course.pages;
  const page = pages.find((p) => String(p.id) === pid) || pages[0];
  const base = preview ? `/courses/${id}/preview` : `/courses/${id}`;
  const done = new Set(course.completed);
  const idx = page ? pages.indexOf(page) : -1;
  // The sidebar follows the outline: top-level pages, and modules with their pages indented beneath. (Pages alone, if there is no outline.)
  const byId = new Map(pages.map((p) => [p.id, p]));
  const pageItem = (p, indent) => ({ to: `${base}/${p.id}`, label: `${done.has(p.id) ? '✓ ' : ''}${p.title}`, selected: p === page, indent });
  const navItems = (course.outline || pages.map((p) => ({ type: 'page', id: p.id }))).flatMap((i) => (i.type === 'page'
    ? [pageItem(byId.get(i.id), false)]
    : [{ heading: true, key: `module-${i.id}`, label: `${i.title} (${i.pages.filter((id) => done.has(id)).length}/${i.pages.length})` }, ...i.pages.map((id) => pageItem(byId.get(id), true))]));
  const parentModule = page ? (course.outline || []).find((i) => i.type === 'module' && i.pages.includes(page.id)) : null;
  const complete = async () => {
    if (preview) return;
    await post(`/api/courses/${id}/pages/${page.id}/complete`);
    setCourse((c) => ({ ...c, completed: [...new Set([...c.completed, page.id])] }));
  };
  const next = pages[idx + 1];

  return (
    <SectionShell ariaLabel="Course pages" items={[{ to: '/courses', label: '← All courses' }, ...navItems]}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 2 }}>
        <Typography variant="h5" component="h1" sx={{ flexGrow: 1 }}>{course.title}</Typography>
        {preview && <Chip label="Preview" color="warning" size="small" />}
        {course.canEdit && !preview && <Button component={RouterLink} to={`/courses/${id}/edit`} size="small">Edit course</Button>}
        {course.canEdit && preview && <Button component={RouterLink} to={`/courses/${id}/edit`} size="small">Back to editor</Button>}
      </Stack>
      {!page ? <Typography color="text.secondary">This course has no pages yet.</Typography> : (
        <>
          {parentModule && <Typography variant="caption" color="text.secondary" data-testid="module-name">{parentModule.title}</Typography>}
          <Typography variant="h6" component="h2">{page.title}</Typography>
          {page.layout === 'assessment' ? (
            <Stack spacing={3}>
              <RichView doc={page.content} />
              {preview ? <Alert severity="info">Learners take the assessment here. Preview doesn't run it.</Alert>
                : <AssessmentRunner key={page.id} id={id} aid={page.assessmentId} onSubmitted={() => get(`/api/courses/${id}`).then(setCourse).catch(() => {})} />}
            </Stack>
          ) : page.layout === 'content' ? <RichView doc={page.content} /> : page.layout === 'agent_file' ? (
            <Stack spacing={3}><RichView doc={page.content} /><FilePanel key={page.id} course={course} page={page} /></Stack>
          ) : (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 3, alignItems: 'start' }}>
              <RichView doc={page.content} />
              {page.layout === 'chat'
                ? <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }}><ChatPanel key={page.id} courseId={course.id} page={page} /></Box>
                : <TutorPanel key={page.id} course={course} page={page} />}
            </Box>
          )}
          <Stack direction="row" spacing={1} sx={{ mt: 3 }}>
            {!done.has(page.id) && !preview && page.layout !== 'assessment' && <Button variant="outlined" onClick={complete}>Mark complete</Button>}
            {next && <Button variant="contained" onClick={async () => { if (page.layout !== 'assessment') await complete(); nav(`${base}/${next.id}`); }}>Next page</Button>}
          </Stack>
        </>
      )}
    </SectionShell>
  );
}
