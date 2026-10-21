import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Chat from '../src/pages/Chat.jsx';
import { renderApp, userWith, ALL } from './helpers.jsx';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const MODELS = { '/api/models': { models: [], defaults: {} } };
const TEACHER = [...ALL.filter((p) => p !== 'chat.use'), 'chat.course.use', 'course.author'];
const COURSES = [{ id: 5, title: 'Intro to Python', status: 'draft' }, { id: 6, title: 'Live course', status: 'published' }];
const sse = (...evs) => new Response(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const routes = (extra = {}) => ({ ...MODELS, '/api/conversations': [], '/api/courses/authored': COURSES, ...extra });

describe('Course Design chat tab', () => {
  it('appears only with both the tab permission and course.author', async () => {
    renderApp(<Chat />, { route: '/chat', user: userWith([...ALL, 'chat.course.use']), routes: routes() });
    await screen.findByText('Coding assistant');
    expect(screen.queryByText('Course design assistant')).toBeNull();
    cleanup();
    renderApp(<Chat />, { route: '/chat', user: userWith(TEACHER), routes: routes() });
    expect(await screen.findByText('Course design assistant')).toBeInTheDocument();
  });

  it('sends the chosen course, shows the changes it made, and asks the server for its own chat list', async () => {
    const turn = sse({ type: 'start', conversationId: 9 }, { type: 'tool_start', id: 't', name: 'create_page', args: {} }, { type: 'tool_result', id: 't', name: 'create_page', result: 'Created page "Loops" (id 3) as page 1.' }, { type: 'text', text: 'Added it.' }, { type: 'done' });
    const { fetch } = renderApp(<Chat />, { route: '/chat', user: userWith(TEACHER), routes: routes({ 'POST /api/chat/turn': () => turn }) });
    const panel = await screen.findByRole('tabpanel', { name: 'Course Design chat' });
    await waitFor(() => expect(within(panel).getByRole('combobox')).toHaveTextContent('Intro to Python')); // first course is preselected
    await userEvent.type(within(panel).getByLabelText('Message'), 'add a loops lesson');
    await userEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.url === '/api/chat/turn')?.body).toMatchObject({ chatType: 'course', courseId: 5, message: 'add a loops lesson' }));
    expect(await within(panel).findByText('Created page "Loops" (id 3) as page 1.')).toBeInTheDocument();
    expect(fetch.calls.some((c) => c.url === '/api/conversations?kind=chat&chatType=course')).toBe(true);
  });

  it('cannot send without a course, and says so when the user teaches none', async () => {
    renderApp(<Chat />, { route: '/chat', user: userWith(TEACHER), routes: routes({ '/api/courses/authored': [] }) });
    const panel = await screen.findByRole('tabpanel', { name: 'Course Design chat' });
    expect(await within(panel).findByText(/don’t teach any courses/)).toBeInTheDocument();
    await userEvent.type(within(panel).getByLabelText('Message'), 'hello');
    expect(within(panel).getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('opening a saved chat switches to its course and locks the picker', async () => {
    renderApp(<Chat />, { route: '/chat', user: userWith(TEACHER), routes: routes({ '/api/conversations': [{ id: 2, title: 'Week 3', courseId: 6 }], '/api/conversations/2/messages': [{ role: 'user', content: 'earlier' }] }) });
    const panel = await screen.findByRole('tabpanel', { name: 'Course Design chat' });
    await userEvent.click(await within(panel).findByText('Week 3'));
    await screen.findByText('earlier');
    expect(within(panel).getByRole('combobox')).toHaveTextContent('Live course (published)');
    expect(within(panel).getByRole('combobox')).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows what the assistant is doing while a page is being written, then replaces it with the result', async () => {
    let push; const body = new ReadableStream({ start(c) { push = (e) => c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)); push({ type: 'start', conversationId: 9 }); }, });
    renderApp(<Chat />, { route: '/chat', user: userWith(TEACHER), routes: routes({ 'POST /api/chat/turn': () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) }) });
    const panel = await screen.findByRole('tabpanel', { name: 'Course Design chat' });
    await waitFor(() => expect(within(panel).getByRole('combobox')).toHaveTextContent('Intro'));
    await userEvent.type(within(panel).getByLabelText('Message'), 'write it');
    await userEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    push({ type: 'phase', phase: 'generating' });
    push({ type: 'tool_progress', id: 't', name: 'create_page', fields: { title: 'Loo' } });
    push({ type: 'tool_progress', id: 't', name: 'create_page', fields: { title: 'ps', markdown: '## Goals\n' + 'x'.repeat(1191) } });
    expect(await within(panel).findByText('Writing “Loops” (1,200 characters)…')).toBeInTheDocument();
    expect(within(panel).getByTestId('course-preview')).toHaveTextContent(/^## Goals\s*x{1191}$/);
    await userEvent.click(within(panel).getByRole('button', { name: 'Hide preview' }));
    expect(within(panel).queryByTestId('course-preview')).toBeNull();
    await userEvent.click(within(panel).getByRole('button', { name: 'Show preview' }));
    expect(within(panel).getByTestId('course-preview')).toBeInTheDocument();
    push({ type: 'tool_start', id: 't', name: 'create_page', args: { title: 'Loops' } });
    push({ type: 'tool_result', id: 't', name: 'create_page', result: 'Created page "Loops" (id 3) as page 1.' });
    expect(await within(panel).findByText('Created page "Loops" (id 3) as page 1.')).toBeInTheDocument();
    expect(within(panel).queryByTestId('course-activity')).toBeNull();
  });
});
