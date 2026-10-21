import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import Courses from '../src/pages/Courses.jsx';
import { renderApp, userWith } from './helpers.jsx';

afterEach(cleanup);
const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Welcome to the lesson' }] }] };
const open = (route, perms, routes) => renderApp(<Routes><Route path="/courses/*" element={<Courses />} /></Routes>, { route, user: userWith(perms), routes });
const course = (over = {}) => ({ id: 7, title: 'Intro', description: 'd', status: 'published', canEdit: false, completed: [],
  pages: [{ id: 1, title: 'One', layout: 'content', content: doc, config: {} }, { id: 2, title: 'Two', layout: 'chat', content: doc, config: {} }], ...over });

describe('courses UI', () => {
  it('learner sees enrolled courses with progress and no authoring section', async () => {
    open('/courses', ['course.learn'], { '/api/courses': [{ id: 7, title: 'Intro', description: 'd', pages: 4, completed: 1 }] });
    expect(await screen.findByText('Intro')).toBeInTheDocument();
    expect(screen.getByText('1 of 4 pages complete')).toBeInTheDocument();
    expect(screen.queryByText('Courses I teach')).toBeNull();
  });

  it('player renders page content, marks complete and moves on to a page with a chat panel', async () => {
    const { fetch } = open('/courses/7', ['course.learn'], { '/api/courses/7': course(), 'POST /api/courses/7/pages/1/complete': { ok: true }, '/api/courses/7/pages/2/conversation': { conversationId: null, messages: [] } });
    expect(await screen.findByText('Welcome to the lesson')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'POST' && c.url === '/api/courses/7/pages/1/complete')).toBe(true));
    expect(await screen.findByLabelText('Ask a question')).toBeInTheDocument();
  });

  it('instructor creates a course and saves a page from the editor', async () => {
    const { fetch } = open('/courses/7/edit', ['course.author'], {
      '/api/courses/7': course({ canEdit: true, pages: [{ id: 1, title: 'One', layout: 'content', content: doc, config: {} }] }),
      'PUT /api/courses/7/pages/1': { id: 1, title: 'Renamed', layout: 'content', content: doc, config: {} },
    });
    const title = await screen.findByLabelText('Page title');
    await userEvent.clear(title); await userEvent.type(title, 'Renamed');
    await userEvent.click(screen.getByRole('button', { name: 'Save page' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'PUT' && c.url === '/api/courses/7/pages/1')).toBe(true));
    const put = fetch.calls.find((c) => c.method === 'PUT');
    expect(put.body).toMatchObject({ title: 'Renamed', layout: 'content', config: {} });
    expect(put.body.content.type).toBe('doc');
  });

  it('a new course: add a page, type into the editor, and save what you typed', async () => {
    let pages = [];
    const page = { id: 5, title: 'Page 1', layout: 'content', content: {}, config: {} };
    const { fetch } = open('/courses/7/edit', ['course.author'], {
      'GET /api/courses/7': () => ({ ...course(), canEdit: true, pages }),
      'POST /api/courses/7/pages': () => { pages = [page]; return page; },
      'PUT /api/courses/7/pages/5': (init) => ({ ...page, ...JSON.parse(init.body) }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Add page' }));
    const editor = await screen.findByRole('textbox', { name: 'Page content' });
    editor.focus(); await userEvent.keyboard('Welcome to the course');
    expect(editor.textContent).toBe('Welcome to the course');
    await userEvent.click(screen.getByRole('button', { name: 'Save page' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(JSON.stringify(fetch.calls.find((c) => c.method === 'PUT').body.content)).toContain('Welcome to the course');
  });

  it('a chat page lets the instructor choose its model, and a content page does not', async () => {
    const page = { id: 2, title: 'Two', layout: 'chat', content: doc, config: { systemPrompt: 'Be brief.' } };
    const { fetch } = open('/courses/7/edit', ['course.author', 'provider.use'], {
      '/api/courses/7': course({ canEdit: true, pages: [{ id: 1, title: 'One', layout: 'content', content: doc, config: {} }, page] }),
      '/api/models': { models: [{ id: 11, label: 'Fast', provider: 'Acme' }, { id: 12, label: 'Smart', provider: 'Acme' }], defaults: {} },
      'PUT /api/courses/7/pages/2': { ...page, config: { systemPrompt: 'Be brief.', modelId: 12 } },
    });
    await screen.findByLabelText('Page title');
    expect(screen.queryByRole('combobox', { name: 'Chat model' })).toBeNull(); // page one is content only
    await userEvent.click(await screen.findByText('Two'));
    await userEvent.click(await screen.findByRole('combobox', { name: 'Chat model' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Smart (Acme)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save page' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'PUT' && c.url === '/api/courses/7/pages/2')?.body.config).toMatchObject({ systemPrompt: 'Be brief.', modelId: 12 }));
  });

  it('SAML-group assignment is offered to course admins only', async () => {
    open('/courses/7/edit', ['course.author'], { '/api/courses/7': course({ canEdit: true }), '/api/courses/7/enrollments': [] });
    await userEvent.click(await screen.findByRole('tab', { name: 'Enrollment' }));
    await userEvent.click(await screen.findByRole('combobox', { name: 'Assign to' }));
    expect(screen.queryByRole('option', { name: 'SAML group' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Person' })).toBeInTheDocument();
  });

  const mod = (over = {}) => {
    const pages = [{ id: 1, title: 'Intro', moduleId: null, layout: 'content', content: doc, config: {} }, { id: 2, title: 'Loops', moduleId: 10, layout: 'content', content: doc, config: {} }, { id: 3, title: 'Vars', moduleId: 10, layout: 'content', content: doc, config: {} }];
    return course({ pages, outline: [{ type: 'page', id: 1 }, { type: 'module', id: 10, title: 'Basics', pages: [2, 3] }], ...over });
  };

  it('learner sees modules as groups with their pages indented and a progress count', async () => {
    open('/courses/7', ['course.learn'], { '/api/courses/7': mod({ completed: [2] }), '/api/courses/7/assessments': [] });
    const nav = await screen.findByRole('navigation', { name: 'Course pages' });
    expect(nav).toHaveTextContent('Basics (1/2)');
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['← All courses', 'Intro', '✓ Loops', 'Vars']);
    await userEvent.click(screen.getByRole('link', { name: 'Vars' }));
    expect(await screen.findByTestId('module-name')).toHaveTextContent('Basics');
  });

  it('instructor adds a module, adds a page inside it, moves things, and renames or deletes a module', async () => {
    const { fetch } = open('/courses/7/edit', ['course.author'], {
      '/api/courses/7': mod({ canEdit: true }), '/api/models': { models: [], defaults: {} },
      'POST /api/courses/7/modules': { id: 11, title: 'Module 2' }, 'POST /api/courses/7/pages': { id: 4, title: 'Page 4', layout: 'content', content: doc, config: {} },
      'PUT /api/courses/7/outline': { ok: true }, 'PUT /api/courses/7/modules/10': { id: 10, title: 'Core' }, 'DELETE /api/courses/7/modules/10': { ok: true },
    });
    const nav = await screen.findByRole('navigation', { name: 'Pages' });
    const group = within(nav).getByRole('group', { name: 'Module Basics' });
    expect(within(group).getByText('Loops')).toBeInTheDocument(); expect(within(group).queryByText('Intro')).toBeNull();
    const sent = (m, u) => fetch.calls.filter((c) => c.method === m && c.url === u).at(-1)?.body; // the latest such call
    await userEvent.click(within(nav).getByRole('button', { name: 'Add module' }));
    await waitFor(() => expect(sent('POST', '/api/courses/7/modules')).toMatchObject({ title: 'Module 2' }));
    await userEvent.click(within(group).getByRole('button', { name: 'Add page to Basics' }));
    await waitFor(() => expect(sent('POST', '/api/courses/7/pages')).toMatchObject({ moduleId: 10 }));
    await userEvent.click(within(group).getByRole('button', { name: 'Move Loops down' }));
    await waitFor(() => expect(sent('PUT', '/api/courses/7/outline')).toEqual({ items: [{ type: 'page', id: 1 }, { type: 'module', id: 10, pages: [3, 2] }] }));
    await userEvent.click(within(group).getByRole('button', { name: 'Move module Basics up' }));
    await waitFor(() => expect(sent('PUT', '/api/courses/7/outline')).toEqual({ items: [{ type: 'module', id: 10, pages: [2, 3] }, { type: 'page', id: 1 }] }));
    await userEvent.click(within(group).getByRole('button', { name: 'Rename module Basics' }));
    const box = await screen.findByLabelText('Module name'); await userEvent.clear(box); await userEvent.type(box, 'Core');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(sent('PUT', '/api/courses/7/modules/10')).toEqual({ title: 'Core' }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(within(group).getByRole('button', { name: 'Delete module Basics' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'DELETE' && c.url === '/api/courses/7/modules/10')).toBe(true));
  });

  it('a page can be moved into a module from its editor', async () => {
    const { fetch } = open('/courses/7/edit', ['course.author'], { '/api/courses/7': mod({ canEdit: true }), '/api/models': { models: [], defaults: {} }, 'PUT /api/courses/7/pages/1': { id: 1, title: 'Intro', layout: 'content', content: doc, config: {} } });
    await userEvent.click(await screen.findByRole('combobox', { name: 'Module' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Basics' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save page' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'PUT' && c.url === '/api/courses/7/pages/1')?.body).toMatchObject({ moduleId: 10 }));
  });
});
