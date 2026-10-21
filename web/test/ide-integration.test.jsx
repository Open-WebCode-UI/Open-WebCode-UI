import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, userWith, ALL } from './helpers.jsx';
import AppLayout from '../src/components/Layout.jsx';
import { sessions } from '../src/sessionStore.js';

vi.mock('@monaco-editor/react', () => ({ default: () => <div data-testid="monaco" />, DiffEditor: () => <div /> }));
const { default: IDE } = await import('../src/pages/IDE.jsx');

const sse = (...evs) => new Response(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const routes = (turn) => ({
  '/api/projects': [{ id: 1, name: 'demo' }], '/api/projects/1/tree': [{ name: 'a.js', path: 'a.js', type: 'file' }], '/api/projects/1/checkpoints': [],
  '/api/models': { models: [{ id: 1, label: 'Fake', provider: 'p' }], defaults: {} }, '/api/skills': [], 'POST /api/agent/turn': turn,
});
beforeEach(() => localStorage.clear());

describe('IDE', () => {
  it('shows every pane (each named) and the editor chrome, with the default arrangement', async () => {
    renderApp(<IDE />, { user: userWith(ALL), routes: routes(() => sse({ type: 'done' })) });
    expect(await screen.findByRole('navigation', { name: 'Editor menu' })).toBeInTheDocument(); expect(screen.getByRole('status', { name: 'Editor status' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent).sort()).toEqual(['Agent', 'Editor', 'Explorer', 'Sessions', 'Terminal']);
    expect(await screen.findByText('a.js')).toBeInTheDocument(); expect(within(screen.getByTestId('pane-terminal')).getByRole('tab', { name: 'Terminal' })).toBeInTheDocument();
  });
  it('rearranging panes keeps the half-typed message (the agent panel is not remounted) and persists the layout', async () => {
    renderApp(<AppLayout><IDE /></AppLayout>, { user: userWith(ALL), routes: routes(() => sse({ type: 'done' })) }); // the Layout menu is in the app header
    await userEvent.type(await screen.findByLabelText('Message'), 'half written idea');
    const chatX = () => parseFloat(screen.getByTestId('pane-chat').style.left);
    await userEvent.click(screen.getByRole('button', { name: 'Agent panel options' })); await userEvent.click(screen.getByRole('menuitem', { name: 'Move to left edge' }));
    expect(screen.getByLabelText('Message')).toHaveValue('half written idea');
    await waitFor(() => expect(JSON.parse(localStorage.getItem('ide-layout-v2')).root.c[0].n.p).toBe('chat'));
    await userEvent.click(screen.getByRole('button', { name: 'Layout' })); await userEvent.click(await screen.findByRole('menuitem', { name: /Chat and terminal at the bottom/ })); expect(screen.getByLabelText('Message')).toHaveValue('half written idea');
    await userEvent.click(screen.getByRole('button', { name: 'Layout' })); await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Terminal' })); expect(screen.getByTestId('pane-terminal')).toHaveAttribute('data-hidden', 'true'); await userEvent.keyboard('{Escape}'); await waitFor(() => expect(screen.queryByRole('menu')).toBeNull()); // the menu stays open while toggling
    await userEvent.click(screen.getByRole('button', { name: 'Layout' })); await userEvent.click(await screen.findByRole('menuitem', { name: /Reset layout/ }));
    expect(screen.getByTestId('pane-terminal')).not.toHaveAttribute('data-hidden'); expect(chatX()).toBeGreaterThanOrEqual(0);
  });
  it('restores a saved layout on the next visit (including one saved by the previous version)', async () => {
    localStorage.setItem('ide-layout-v1', JSON.stringify({ docks: { explorer: 'right', chat: 'bottom', terminal: 'hidden' }, sizes: { left: 300, right: 300, bottom: 300 } }));
    renderApp(<IDE />, { user: userWith(ALL), routes: routes(() => sse({ type: 'done' })) });
    expect(await screen.findByTestId('pane-terminal')).toHaveAttribute('data-hidden', 'true'); expect(screen.getByTestId('pane-chat')).not.toHaveAttribute('data-hidden');
  });
  it('the conversation survives leaving the IDE and coming back, and the Sessions pane lists it', async () => {
    let release; const gate = new Promise((r) => { release = r; }); const enc = new TextEncoder();
    const turn = () => new Response(new ReadableStream({ async start(c) { const send = (e) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); send({ type: 'start', conversationId: 21 }); send({ type: 'text', text: 'Looking at your project.' }); await gate; send({ type: 'text', text: ' All done.' }); send({ type: 'done' }); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
    const rs = { ...routes(turn), '/api/sessions': [{ id: 21, title: 'Tidy the repo', createdAt: 0, updatedAt: Math.floor(Date.now() / 1000), mode: 'plan', messages: 2, running: false, context: { tokens: 900, limit: 128000, pct: 1, level: 'ok' } }] };
    const first = renderApp(<IDE />, { user: userWith(ALL), routes: rs });
    await screen.findByText('a.js', {}, { timeout: 4000 }); // the project has loaded
    await userEvent.type(await screen.findByLabelText('Message', {}, { timeout: 4000 }), 'tidy the repo'); await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Looking at your project.', {}, { timeout: 4000 })).toBeInTheDocument();
    first.unmount();                                                      // navigate to Help, say
    release(); await waitFor(() => expect(sessions.get(1).busy).toBe(false), { timeout: 4000 }); // the turn finished while the IDE was away
    renderApp(<IDE />, { user: userWith(ALL), routes: rs });             // back again
    expect(await screen.findByText('Looking at your project. All done.', {}, { timeout: 4000 })).toBeInTheDocument(); expect(screen.getByText('tidy the repo')).toBeInTheDocument(); // one reply, finished while away
    expect(await within(screen.getByTestId('pane-sessions')).findByText('Tidy the repo', {}, { timeout: 4000 })).toBeInTheDocument();
  });
  it('clicking a checkpoint chip in the conversation opens the Checkpoints tab at that entry', async () => {
    const cps = [{ id: 'a'.repeat(40), ts: 1, label: 'Start of turn', author: 'system' }, { id: 'b'.repeat(40), ts: 2, label: 'Before refactor', author: 'agent' }];
    const turn = () => sse({ type: 'start', conversationId: 31 }, { type: 'checkpoint', ...cps[1] }, { type: 'done' });
    renderApp(<IDE />, { user: userWith(ALL), routes: { ...routes(turn), '/api/projects/1/checkpoints': cps } });
    await userEvent.type(await screen.findByLabelText('Message', {}, { timeout: 4000 }), 'go'); await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Checkpoint: Before refactor' }, { timeout: 4000 }));
    expect(await screen.findByRole('tab', { name: 'Checkpoints', selected: true })).toBeInTheDocument();
    await waitFor(() => expect(document.getElementById(`cp-${'b'.repeat(40)}`)).toHaveAttribute('data-focused', 'true'));
  });
});

describe('IDE project link', () => {
  it('opens the project named in the address (a course exercise workspace) instead of the first one', async () => {
    const r = routes(() => sse({ type: 'done' }));
    renderApp(<IDE />, { route: '/?project=2', user: userWith(ALL), routes: { ...r, '/api/projects': [{ id: 1, name: 'demo' }, { id: 2, name: 'course-7-a1-q3' }], '/api/projects/2/tree': [{ name: 'notes.md', path: 'notes.md', type: 'file' }], '/api/projects/2/checkpoints': [] } });
    expect(await screen.findByText('notes.md')).toBeInTheDocument();
  });
});

describe('exercise rules in the IDE', () => {
  const at = (rules) => renderApp(<IDE />, { route: '/?project=2', user: userWith(ALL), routes: { ...routes(() => sse({ type: 'done' })), '/api/projects': [{ id: 1, name: 'demo' }, { id: 2, name: 'course-7-a1-q3' }], '/api/projects/2/tree': [], '/api/projects/2/checkpoints': [], '/api/projects/2/exercise-policy': rules } });
  it('shows the rules and turns Act off when the exercise is plan-only', async () => {
    at({ mode: 'plan', shell: false, locked: false, deadline: null, summary: ['You can plan with the agent, but not let it change files.', 'Git and downloads are off.'] });
    expect(await screen.findByText('Git and downloads are off.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Act mode' })).toBeDisabled();
  });
  it('says so when the workspace is read-only after submitting', async () => {
    at({ mode: 'act', shell: false, locked: true, submitted: true, deadline: null, summary: [] });
    expect(await screen.findByText('Exercise submitted: this workspace is read-only.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Act mode' })).toBeDisabled();
  });
  it('shows nothing for an ordinary project', async () => {
    at(null);
    await screen.findByRole('button', { name: 'Act mode' });
    expect(screen.queryByLabelText('Exercise rules')).toBeNull(); expect(screen.getByRole('button', { name: 'Act mode' })).toBeEnabled();
  });
});
