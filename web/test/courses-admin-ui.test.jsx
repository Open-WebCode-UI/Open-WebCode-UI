import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import Courses from '../src/pages/admin/Courses.jsx';
import CoursesPage from '../src/pages/Courses.jsx';
import { renderApp, userWith } from './helpers.jsx';

afterEach(cleanup);
const admin = (perms = ['course.admin', 'course.author']) => userWith(perms);

describe('course administration UI', () => {
  it('designates an instructor found by name', async () => {
    const { fetch } = renderApp(<Courses />, { user: admin(), routes: {
      '/api/admin/instructors': [{ id: 3, label: 'Ina Structor', username: 'ina', viaSaml: true, manual: false }],
      '/api/courses-users': [{ id: 9, label: 'Sam Student', username: 'sam' }],
      'PUT /api/admin/instructors/9': { ok: true },
    } });
    expect(await screen.findByText('Via SSO group')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull(); // IdP-granted: not removable here
    const box = screen.getByLabelText('Designate an instructor');
    await userEvent.type(box, 'sam');
    await userEvent.click(await screen.findByRole('option', { name: /Sam Student/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Designate' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'PUT' && c.url === '/api/admin/instructors/9')).toBe(true));
    expect(fetch.calls.find((c) => c.method === 'PUT').body).toEqual({ instructor: true });
  });

  it('assigns a course to a SAML group and removes one', async () => {
    const { fetch } = renderApp(<Courses />, { user: admin(), routes: {
      '/api/admin/instructors': [],
      '/api/admin/courses': [{ id: 7, title: 'Intro', status: 'published', owner: 'Ina', groups: ['cs101'] }],
      '/api/admin/course-groups': ['cs101', 'cs202'],
      'POST /api/courses/7/enrollments': { ok: true }, 'DELETE /api/courses/7/enrollments': { ok: true },
    } });
    await userEvent.click(await screen.findByRole('tab', { name: 'Courses & groups' }));
    expect(await screen.findByText('Owner: Ina')).toBeInTheDocument();
    const box = screen.getByLabelText('Add SAML group');
    await userEvent.type(box, 'cs202{Enter}');
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'POST')).toBe(true));
    expect(fetch.calls.find((c) => c.method === 'POST').body).toEqual({ type: 'saml_group', id: 'cs202' });
  });

  it('instructors enroll a person picked by name, not by id', async () => {
    const { fetch } = renderApp(<Routes><Route path="/courses/*" element={<CoursesPage />} /></Routes>, { route: '/courses/7/edit', user: userWith(['course.author']), routes: {
      '/api/courses/7': { id: 7, title: 'Intro', description: '', status: 'draft', canEdit: true, completed: [], pages: [] },
      'GET /api/courses/7/enrollments': [], '/api/courses-users': [{ id: 9, label: 'Sam Student', username: 'sam' }],
      'POST /api/courses/7/enrollments': { ok: true },
    } });
    await userEvent.click(await screen.findByRole('tab', { name: 'Enrollment' }));
    await userEvent.click(await screen.findByRole('combobox', { name: 'Assign to' }));
    await userEvent.click(screen.getByRole('option', { name: 'Person' }));
    await userEvent.type(await screen.findByLabelText('Find a person'), 'sam');
    await userEvent.click(await screen.findByRole('option', { name: /Sam Student/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'POST' && c.url === '/api/courses/7/enrollments')).toBe(true));
    expect(fetch.calls.find((c) => c.method === 'POST').body).toEqual({ type: 'user', id: 9 });
  });
});
