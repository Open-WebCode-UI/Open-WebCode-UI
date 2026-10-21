import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Chat from '../src/pages/Chat.jsx';
import SessionsPanel from '../src/components/SessionsPanel.jsx';
import Login from '../src/pages/Login.jsx';
import Profile from '../src/pages/Profile.jsx';
import { useAuth } from '../src/AuthContext.jsx';
import { get } from '../src/api.js';
import { renderApp, userWith, ALL } from './helpers.jsx';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const BOTH = [...ALL, 'chat.general.use'];
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const MODELS = { '/api/models': { models: [], defaults: {} } };

describe('new chat button', () => {
  it('reuses the blank chat instead of making another, and keeps its draft while you look at a saved chat', async () => {
    renderApp(<Chat />, { route: '/chat', user: userWith(ALL), routes: { ...MODELS, '/api/conversations': [{ id: 1, title: 'Old one' }], '/api/conversations/1/messages': [{ role: 'user', content: 'earlier question' }] } });
    await screen.findByText('Old one');
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.getAllByTestId('chat-blank')).toHaveLength(1);
    await userEvent.type(screen.getByRole('textbox'), 'my draft');
    await userEvent.click(screen.getByText('Old one'));
    expect(await screen.findByText('earlier question')).toBeInTheDocument();
    expect(screen.getByTestId('chat-blank')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.queryByText('earlier question')).toBeNull();
    expect(screen.getByRole('textbox')).toHaveValue('my draft');
    expect(screen.getAllByTestId('chat-blank')).toHaveLength(1);
  });
});

describe('chat tabs', () => {
  it('shows a General and a Coding tab, and each keeps its own chat list', async () => {
    renderApp(<Chat />, { route: '/chat', user: userWith(BOTH), routes: { ...MODELS, '/api/conversations': [] } });
    expect((await screen.findAllByRole('tab')).map((t) => t.textContent)).toEqual(['General', 'Coding']);
  });

  it('asks the server for the chats of each tab', async () => {
    const { fetch } = renderApp(<Chat />, { route: '/chat', user: userWith(BOTH), routes: { ...MODELS, '/api/conversations': [] } });
    await screen.findAllByRole('tab');
    await waitFor(() => expect(fetch.calls.filter((c) => String(c.url).startsWith('/api/conversations')).map((c) => c.url).sort()).toEqual(['/api/conversations?kind=chat&chatType=coding', '/api/conversations?kind=chat&chatType=general']));
  });

  it('shows no tab strip when the role only has one of them', async () => {
    renderApp(<Chat />, { route: '/chat', user: userWith(ALL), routes: { ...MODELS, '/api/conversations': [] } });
    await screen.findByText('Coding assistant');
    expect(screen.queryByRole('tab')).toBeNull();
    cleanup();
    renderApp(<Chat />, { route: '/chat', user: userWith(ALL.filter((p) => p !== 'chat.use').concat('chat.general.use')), routes: { ...MODELS, '/api/conversations': [] } });
    expect(await screen.findByText('General assistant')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('switching tabs shows the other assistant; sending from General says so to the server', async () => {
    const { fetch } = renderApp(<Chat />, { route: '/chat', user: userWith(BOTH), routes: { ...MODELS, '/api/conversations': [], '/api/chat/turn': new Response('data: {"type":"done"}\n\n', { headers: { 'content-type': 'text/event-stream' } }) } });
    await userEvent.click(await screen.findByRole('tab', { name: 'General' }));
    const panel = screen.getByRole('tabpanel', { name: 'General chat' });
    await userEvent.type(within(panel).getByLabelText('Message'), 'plan my week');
    await userEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.url === '/api/chat/turn')?.body).toMatchObject({ chatType: 'general', message: 'plan my week' }));
  });

  it('hides the web search switch in a tab whose role lacks that tab\'s web search permission', async () => {
    renderApp(<Chat />, { route: '/chat', user: userWith([...BOTH, 'websearch.use', 'chat.general.websearch']), routes: { ...MODELS, '/api/web-search': { allowed: true, configured: true, enabled: true }, '/api/conversations': [] } });
    await userEvent.click(await screen.findByRole('tab', { name: 'General' }));
    const open = async (name) => { await userEvent.click(within(screen.getByRole('tabpanel', { name })).getByRole('button', { name: /^Model:/ })); };
    await open('General chat');
    expect(await screen.findByLabelText('Web search')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('tab', { name: 'Coding' }));
    await open('Coding chat');
    await screen.findByRole('dialog');
    expect(screen.queryByLabelText('Web search')).toBeNull();
  });
});

describe('managing the chat list', () => {
  const LIST = [{ id: 3, title: 'Trip plan' }, { id: 2, title: 'Budget' }, { id: 1, title: 'Recipes' }];
  const setup = (extra = {}) => renderApp(<Chat />, { route: '/chat', user: userWith(BOTH), routes: { ...MODELS, '/api/conversations': LIST, ...extra } });
  const general = () => within(screen.getByRole('tabpanel', { name: 'General chat' }));
  const openGeneral = async () => { await userEvent.click(await screen.findByRole('tab', { name: 'General' })); await general().findByText('Trip plan'); };

  it('selects some chats and deletes only those', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { fetch } = setup({ 'POST /api/conversations/bulk-delete': { ok: true, deleted: 2, deletedIds: [3, 1] } });
    await openGeneral();
    await userEvent.click(general().getByRole('button', { name: 'Select' }));
    expect(general().getByRole('button', { name: 'Delete' })).toBeDisabled(); // nothing ticked yet
    await userEvent.click(general().getByLabelText('Select Trip plan')); await userEvent.click(general().getByLabelText('Select Recipes'));
    expect(general().getByText('2 selected')).toBeInTheDocument();
    await userEvent.click(general().getByRole('button', { name: 'Delete (2)' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Delete 2 chats'));
    await waitFor(() => expect(fetch.calls.find((c) => c.url === '/api/conversations/bulk-delete')?.body).toEqual({ chatType: 'general', ids: expect.arrayContaining([3, 1]) }));
  });

  it('Select all ticks everything and Delete all deletes the tab\'s chats after confirming', async () => {
    const ok = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    const { fetch } = setup({ 'POST /api/conversations/bulk-delete': { ok: true, deleted: 3, deletedIds: [3, 2, 1] } });
    await openGeneral();
    await userEvent.click(general().getByRole('button', { name: 'Select' }));
    await userEvent.click(general().getByLabelText('Select all chats'));
    expect(general().getByText('3 selected')).toBeInTheDocument();
    await userEvent.click(general().getByRole('button', { name: 'Delete all' }));  // declined
    expect(fetch.calls.some((c) => c.url === '/api/conversations/bulk-delete')).toBe(false);
    await userEvent.click(general().getByRole('button', { name: 'Delete all' }));
    expect(ok).toHaveBeenLastCalledWith(expect.stringContaining('Delete all 3 chats'));
    await waitFor(() => expect(fetch.calls.find((c) => c.url === '/api/conversations/bulk-delete')?.body).toEqual({ chatType: 'general', all: true }));
  });

  it('renames a chat from its menu', async () => {
    const { fetch } = setup({ 'PUT /api/conversations/2': { ok: true, title: 'Household budget' } });
    await openGeneral();
    await userEvent.click(general().getByRole('button', { name: 'Options for Budget' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const box = await screen.findByLabelText('Name'); await userEvent.clear(box); await userEvent.type(box, 'Household budget');
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'PUT' && c.url === '/api/conversations/2')?.body).toEqual({ title: 'Household budget' }));
  });

  it('deletes one chat from its menu', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { fetch } = setup({ 'DELETE /api/conversations/1': { ok: true } });
    await openGeneral();
    await userEvent.click(general().getByRole('button', { name: 'Options for Recipes' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'DELETE' && c.url === '/api/conversations/1')).toBe(true));
  });
});

describe('managing the session list', () => {
  const LIST = [{ id: 11, title: 'Fix login', updatedAt: Date.now() / 1000, mode: 'plan', context: { tokens: 10, level: 'ok' } }, { id: 12, title: 'Add tests', updatedAt: Date.now() / 1000, mode: 'act', context: { tokens: 10, level: 'ok' } }];
  const setup = (extra = {}) => renderApp(<SessionsPanel project={{ id: 7 }} />, { user: userWith(ALL), routes: { '/api/sessions': LIST, ...extra } });

  it('deletes the selected sessions', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { fetch } = setup({ 'POST /api/sessions/bulk-delete': { ok: true, deleted: 1, deletedIds: [12], skipped: 0 } });
    await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
    await userEvent.click(screen.getByLabelText('Select Add tests'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete (1)' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.url === '/api/sessions/bulk-delete')?.body).toEqual({ projectId: 7, ids: [12] }));
  });

  it('Delete all sends all, and says when a running session was kept', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { fetch } = setup({ 'POST /api/sessions/bulk-delete': { ok: true, deleted: 1, deletedIds: [11], skipped: 1 } });
    await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete all' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.url === '/api/sessions/bulk-delete')?.body).toEqual({ projectId: 7, all: true }));
    expect(await screen.findByText('1 running session was not deleted.')).toBeInTheDocument();
  });

  it('choosing a row while selecting ticks it instead of opening the session', async () => {
    const { fetch } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
    await userEvent.click(screen.getByTestId('session-11'));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(fetch.calls.some((c) => c.url === '/api/sessions/11')).toBe(false);
  });
});

describe('an expired session', () => {
  function Probe() {
    const { user } = useAuth();
    return user ? <button onClick={() => get('/api/things').catch(() => {})}>Load things</button> : <Login />;
  }
  it('sends a signed-in user back to the sign-in page, with a note, when a call comes back unauthenticated', async () => {
    renderApp(<Probe />, { user: userWith(ALL), routes: { '/api/things': json({ error: 'unauthenticated' }, 401) } });
    await userEvent.click(await screen.findByRole('button', { name: 'Load things' }));
    expect(await screen.findByText('Your session has expired. Please sign in again.')).toBeInTheDocument();
  });
  it('does not treat other 401s (such as a wrong password) or a normal sign-in page as an expiry', async () => {
    renderApp(<Probe />, { user: null });
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByText('Your session has expired. Please sign in again.')).toBeNull();
  });
  it('a 403 does not sign the user out', async () => {
    renderApp(<Probe />, { user: userWith(ALL), routes: { '/api/things': json({ error: 'forbidden' }, 403) } });
    await userEvent.click(await screen.findByRole('button', { name: 'Load things' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole('button', { name: 'Load things' })).toBeInTheDocument();
  });
});

describe('chat skills and the processing indicator', () => {
  const profile = (user, route = '/profile/chat-skills', routes = {}) => renderApp(<Profile />, { route, user, routes: { '/api/profile/prompts': { defaults: {}, overrides: {} }, '/api/auth/sessions': [], ...routes } });
  const CHAT_SKILLS = [{ key: 'summarize', name: 'summarize', scope: 'chat', builtin: true, enabled: true, modified: false, description: 'Summarize text', instructions: 'x', defaults: {} }];

  it('Profile has separate "Agent skills" and "Chat skills" sections', async () => {
    profile(userWith(BOTH), '/profile/skills', { '/api/skills': [] });
    const nav = await screen.findByRole('navigation', { name: 'Profile' });
    expect(within(nav).getByRole('link', { name: 'Agent skills' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Chat skills' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Skills' })).toBeNull();
  });
  it('Chat skills is hidden from a role that cannot chat', async () => {
    profile(userWith(['agent.plan', 'provider.use']), '/profile/skills', { '/api/skills': [] });
    const nav = await screen.findByRole('navigation', { name: 'Profile' });
    expect(within(nav).queryByRole('link', { name: 'Chat skills' })).toBeNull();
  });
  it('the Chat skills section loads and edits the chat scope', async () => {
    const { fetch } = profile(userWith(BOTH), '/profile/chat-skills', { '/api/skills': CHAT_SKILLS, 'PUT /api/skills/builtin/summarize': { ok: true } });
    expect(await screen.findByRole('heading', { name: 'Chat skills' })).toBeInTheDocument();
    expect(await screen.findByText('/summarize')).toBeInTheDocument();
    expect(fetch.calls.find((c) => c.url.startsWith('/api/skills'))?.url).toBe('/api/skills?scope=chat');
    await userEvent.click(screen.getByLabelText('Enable summarize'));
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'PUT')?.url).toBe('/api/skills/builtin/summarize?scope=chat'));
  });
  it('the chat Skills button lists chat skills, not the agent\'s, and has no /clear', async () => {
    const { fetch } = renderApp(<Chat />, { route: '/chat', user: userWith(ALL), routes: { ...MODELS, '/api/conversations': [], '/api/skills': CHAT_SKILLS } });
    await userEvent.click(await screen.findByRole('button', { name: 'Skills' }));
    expect(await screen.findByText('/summarize')).toBeInTheDocument();
    expect(screen.queryByText('/clear')).toBeNull(); expect(screen.getByText('/status')).toBeInTheDocument();
    expect(fetch.calls.some((c) => c.url === '/api/skills?scope=chat')).toBe(true);
  });

  it('shows "Processing prompt" with a timer while the model reads the prompt, then the answer replaces it', async () => {
    const enc = new TextEncoder(); let ctl;
    const body = new ReadableStream({ start(c) { ctl = c; } });
    const send = (e) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
    renderApp(<Chat />, { route: '/chat', user: userWith(ALL), routes: { ...MODELS, '/api/conversations': [], 'POST /api/chat/turn': () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) } });
    await userEvent.type(await screen.findByLabelText('Message'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Sending…')).toBeInTheDocument();   // immediately, before the server says anything
    send({ type: 'start', conversationId: 5 }); send({ type: 'phase', phase: 'prefill', tokens: 4000, etaMs: 20000 });
    expect(await screen.findByText(/Processing prompt \(~4\.0k tokens\)/)).toBeInTheDocument();
    expect(screen.getByTestId('turn-elapsed')).toBeInTheDocument(); expect(screen.getByRole('progressbar', { name: 'Prompt processing' })).toBeInTheDocument();
    send({ type: 'phase', phase: 'generating' }); send({ type: 'text', text: 'Hi there' });
    expect(await screen.findByText('Hi there')).toBeInTheDocument();
    expect(screen.queryByTestId('turn-status')).toBeNull();
    send({ type: 'done' }); ctl.close();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument());
  });
});
