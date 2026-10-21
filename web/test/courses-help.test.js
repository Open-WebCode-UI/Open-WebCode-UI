import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TOPICS, GROUPS } from '../src/help/content.js';
import { visibleTopics } from '../src/help/visible.js';
import { NAV } from '../src/components/Layout.jsx';

const ids = (perms) => visibleTopics((p) => perms.includes(p)).map((t) => t.id);
const topic = (id) => TOPICS.find((t) => t.id === id);
const COURSE_TOPICS = ['courses-learn', 'courses-exercises', 'courses-build', 'courses-assess', 'courses-exercise-design'];

describe('course help: who sees what', () => {
  it('has a Courses group between the agent help and the account help', () => {
    expect(GROUPS.indexOf('Courses')).toBe(GROUPS.indexOf('Work with the agent') + 1);
    for (const id of COURSE_TOPICS) expect(topic(id).group, id).toBe('Courses');
  });
  it('learners get the learner guides only, instructors the building guides, administrators the setup guide', () => {
    expect(ids(['course.learn'])).toEqual(expect.arrayContaining(['courses-learn', 'courses-exercises']));
    expect(ids(['course.learn']).filter((i) => ['courses-build', 'courses-assess', 'courses-exercise-design', 'admin-courses'].includes(i))).toEqual([]);
    expect(ids(['course.author'])).toEqual(expect.arrayContaining(['courses-build', 'courses-assess', 'courses-exercise-design']));
    expect(ids(['course.author'])).not.toContain('courses-learn');
    expect(ids(['course.admin'])).toEqual(expect.arrayContaining(['admin-courses', 'admin-overview']));
    expect(ids([]).filter((i) => i.startsWith('courses-') || i === 'admin-courses')).toEqual([]);
  });
  it('a course administrator sees the Admin link and the Courses entry in it', () => {
    const admin = NAV.find((n) => n.to === '/admin');
    expect(admin.anyOf).toContain('course.admin');
    expect(NAV.find((n) => n.to === '/courses').anyOf).toEqual(['course.learn', 'course.author', 'course.admin']);
  });
  it('every link between the course guides points at a real topic', () => {
    for (const id of [...COURSE_TOPICS, 'admin-courses']) for (const m of topic(id).body.matchAll(/\]\(#([a-z0-9-]+)\)/g)) expect(topic(m[1]), `${id} -> ${m[1]}`).toBeTruthy();
  });
});

// The guides name buttons, tabs, and fields in bold. If someone renames one in the app, the guide must change with it.
describe('course help names real things on screen', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const src = [
    'src/pages/Courses.jsx', 'src/pages/courses/Author.jsx', 'src/pages/courses/AssessmentsEditor.jsx', 'src/pages/courses/Assessment.jsx', 'src/pages/courses/Player.jsx', 'src/pages/courses/Panels.jsx',
    'src/pages/admin/Courses.jsx', 'src/pages/admin/Users.jsx', 'src/pages/admin/AdminLayout.jsx', 'src/pages/admin/Servers.jsx', 'src/components/Layout.jsx', '../server/src/settings.js',
  ].map(read).join('\n').replace(/&amp;/g, '&');
  // Bold text that is emphasis, a role name, or a control that lives elsewhere in the app.
  const NOT_UI = new Set(['They never run code or commands', 'developer', 'chat-general', 'instructor', 'x', 'Act', 'Users', 'Server (AI services)', 'Admin']);
  const bolds = (md) => [...md.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1].replace(/[:…]+$/, '').trim()).filter((b) => b && !NOT_UI.has(b));

  it('every bold label in the course guides appears in the app', () => {
    const missing = [];
    for (const id of [...COURSE_TOPICS, 'admin-courses']) for (const b of bolds(topic(id).body)) if (!src.includes(b)) missing.push(`${id}: ${b}`);
    expect(missing).toEqual([]);
  });
  it('the learner and instructor guides stay out of the Administer group, and the setup guide names its page', () => {
    expect(topic('admin-courses').group).toBe('Administer');
    expect(topic('admin-courses').body).toContain('Go to **Admin**, then **Courses**');
  });
});
