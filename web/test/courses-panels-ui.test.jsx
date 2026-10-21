import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import CoursesPage from '../src/pages/Courses.jsx';
import AdminCourses from '../src/pages/admin/Courses.jsx';
import { renderApp, userWith } from './helpers.jsx';

vi.mock('@monaco-editor/react', () => ({ default: (p) => <textarea data-testid="monaco" data-language={p.language} value={p.value} onChange={(e) => p.onChange?.(e.target.value)} /> }));

afterEach(cleanup);
const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Lesson text' }] }] };
const SUBS = [{ id: 'hints', label: 'Hints', type: 'hints', enabled: true }, { id: 'notes', label: 'My notes', type: 'notes', enabled: true }, { id: 'resources', label: 'Links', type: 'resources', enabled: true }];
const agentPage = { id: 2, title: 'Scope', layout: 'agent', content: doc, config: { subpanels: ['hints', 'resources'], subpanelContent: { hints: { hints: ['First hint', 'Second hint'] }, resources: { links: [{ title: 'MDN', url: 'https://developer.mozilla.org' }] } } } };
const course = (pages) => ({ id: 7, title: 'JS', description: '', status: 'published', canEdit: false, completed: [], subpanels: SUBS, pages });
const open = (route, perms, routes) => renderApp(<Routes><Route path="/courses/*" element={<CoursesPage />} /></Routes>, { route, user: userWith(perms), routes });

describe('course page panels', () => {
  it('tutor page shows enabled subpanels as tabs; hints reveal one at a time; links open safely', async () => {
    open('/courses/7', ['course.learn'], { '/api/courses/7': course([agentPage]), '/api/courses/7/pages/2/conversation': { conversationId: null, messages: [] } });
    expect(await screen.findByRole('tab', { name: 'Hints' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'My notes' })).toBeNull(); // not turned on for this page
    await userEvent.click(screen.getByRole('tab', { name: 'Hints' }));
    expect(screen.queryByText(/First hint/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show a hint' }));
    expect(screen.getByText('1. First hint')).toBeInTheDocument(); expect(screen.queryByText(/Second hint/)).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Links' }));
    const a = screen.getByRole('link', { name: 'MDN' });
    expect(a).toHaveAttribute('rel', 'noopener noreferrer'); expect(a).toHaveAttribute('target', '_blank');
  });

  it('chat page: loads history, streams a reply into the log', async () => {
    const page = { id: 3, title: 'Ask', layout: 'chat', content: doc, config: {} };
    const sse = (events) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const { fetch } = open('/courses/7', ['course.learn'], {
      '/api/courses/7': course([page]),
      'GET /api/courses/7/pages/3/conversation': { conversationId: 1, messages: [{ role: 'user', content: 'earlier q' }, { role: 'assistant', content: 'earlier a' }] },
      'POST /api/courses/7/pages/3/turn': () => sse([{ type: 'start', conversationId: 1 }, { type: 'text', text: 'Scope is ' }, { type: 'text', text: 'where names live.' }, { type: 'done' }]),
    });
    expect(await screen.findByText('earlier q')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Ask a question'), 'What is scope?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Scope is where names live.')).toBeInTheDocument();
    expect(fetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/turn')).body).toEqual({ message: 'What is scope?' });
  });

  it('chat page: streams the thinking into its own block ahead of the answer', async () => {
    const page = { id: 3, title: 'Ask', layout: 'chat', content: doc, config: { thinking: true } };
    const sse = (events) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    open('/courses/7', ['course.learn'], {
      '/api/courses/7': course([page]),
      'GET /api/courses/7/pages/3/conversation': { conversationId: null, messages: [] },
      'POST /api/courses/7/pages/3/turn': () => sse([{ type: 'start', conversationId: 1 }, { type: 'thinking', text: 'Weighing options' }, { type: 'text', text: 'Final answer.' }, { type: 'done' }]),
    });
    await userEvent.type(await screen.findByLabelText('Ask a question'), 'Why?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Final answer.')).toBeInTheDocument();
    expect(screen.getByTestId('thinking')).toBeInTheDocument();
  });

  it('instructor can turn thinking on for a page, and it is saved in the page config', async () => {
    const { fetch } = open('/courses/7/edit', ['course.author'], {
      '/api/courses/7': { ...course([{ ...agentPage, config: {} }]), canEdit: true },
      '/api/models': { models: [], defaults: {} },
      'PUT /api/courses/7/pages/2': { ...agentPage },
    });
    const sw = await screen.findByRole('switch', { name: 'Thinking' });
    expect(sw).not.toBeChecked();
    await userEvent.click(sw);
    await userEvent.click(screen.getByRole('button', { name: 'Save page' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(fetch.calls.find((c) => c.method === 'PUT').body.config.thinking).toBe(true);
  });

  it('instructor picks tutor panels and writes hints and resources', async () => {
    const { fetch } = open('/courses/7/edit', ['course.author'], {
      '/api/courses/7': { ...course([{ ...agentPage, config: {} }]), canEdit: true },
      'PUT /api/courses/7/pages/2': { ...agentPage },
    });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Hints' }));
    await userEvent.type(await screen.findByLabelText(/Hints \(one per line/), 'Check declaration{Enter}Check blocks');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Links' }));
    await userEvent.type(await screen.findByLabelText(/Resources \(one per line/), 'MDN | https://developer.mozilla.org');
    await userEvent.click(screen.getByRole('button', { name: 'Save page' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(fetch.calls.find((c) => c.method === 'PUT').body.config).toEqual({ subpanels: ['hints', 'resources'], subpanelContent: { hints: { hints: ['Check declaration', 'Check blocks'] }, resources: { links: [{ title: 'MDN', url: 'https://developer.mozilla.org' }] } } });
  });

  it('administrators manage the panel catalog', async () => {
    const { fetch } = renderApp(<AdminCourses />, { user: userWith(['course.admin']), routes: {
      '/api/admin/instructors': [], 'GET /api/admin/course-settings': { subpanels: SUBS }, 'PUT /api/admin/course-settings': (init) => JSON.parse(init.body),
    } });
    await userEvent.click(await screen.findByRole('tab', { name: 'Tutor panels' }));
    await userEvent.click(await screen.findByRole('switch', { name: 'Enable My notes' }));
    await userEvent.type(screen.getByLabelText('New panel name'), 'Study plan');
    await userEvent.click(screen.getByRole('button', { name: 'Add panel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save panels' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'PUT')).toBe(true));
    const sent = fetch.calls.find((c) => c.method === 'PUT').body.subpanels;
    expect(sent.find((s) => s.id === 'notes').enabled).toBe(false);
    expect(sent.at(-1)).toEqual({ id: 'study-plan', label: 'Study plan', type: 'notes', enabled: true });
  });
  it('administrators restrict the models instructors can choose', async () => {
    const providers = [{ id: 1, name: 'Acme', models: [{ id: 11, modelId: 'fast', label: 'Fast', enabled: true }, { id: 12, modelId: 'smart', label: 'Smart', enabled: true }] }];
    const { fetch } = renderApp(<AdminCourses />, { user: userWith(['course.admin']), routes: {
      '/api/admin/instructors': [], '/api/admin/providers': providers, 'GET /api/admin/course-settings': { subpanels: SUBS, allowedModelIds: null }, 'PUT /api/admin/course-settings': (init) => JSON.parse(init.body),
    } });
    await userEvent.click(await screen.findByRole('tab', { name: 'Models' }));
    await userEvent.click(await screen.findByRole('switch', { name: /Restrict the models/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Smart' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save models' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(fetch.calls.find((c) => c.method === 'PUT').body).toEqual({ allowedModelIds: [11] });
  });

  it('agent-and-file page: shows the learner\'s file in the editor with the chat beneath it', async () => {
    const page = { id: 4, title: 'Loops', layout: 'agent_file', content: doc, config: { fileName: 'loops.py' } };
    open('/courses/7', ['course.learn'], { '/api/courses/7': course([page]), '/api/courses/7/pages/4/file': { name: 'loops.py', content: 'print(1)', modified: false }, '/api/courses/7/pages/4/conversation': { conversationId: null, messages: [] } });
    const ed = await screen.findByTestId('monaco');
    expect(ed).toHaveValue('print(1)'); expect(ed).toHaveAttribute('data-language', 'python');
    expect(screen.getByText('loops.py')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Ask the assistant to change the file' })).toBeInTheDocument();
  });
});
