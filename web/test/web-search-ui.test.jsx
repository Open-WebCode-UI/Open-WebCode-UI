import { describe, it, expect, afterEach } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Profile from '../src/pages/Profile.jsx';
import Chat from '../src/pages/Chat.jsx';
import AdminLayout from '../src/pages/admin/AdminLayout.jsx';
import { Route, Routes } from 'react-router-dom';
import { renderApp, userWith, ALL } from './helpers.jsx';

afterEach(cleanup);
const PERMS = [...ALL, 'websearch.use', 'chat.coding.websearch'];
const status = (over = {}) => ({ allowed: true, configured: true, enabled: true, ...over });
const chatRoutes = (st) => ({ '/api/web-search': st, '/api/models': { models: [], defaults: {} }, '/api/conversations': [] });

// Chat settings live in the model dialog.
const openSettings = async () => userEvent.click(await screen.findByRole('button', { name: /^Model:/ }));

describe('web search (chat toggle)', () => {
  it('is hidden without the permission', async () => {
    renderApp(<Chat />, { route: '/chat', user: userWith(ALL), routes: chatRoutes(status()) });
    await screen.findByLabelText('Message');
    await openSettings();
    expect(screen.queryByLabelText('Web search')).toBeNull();
  });

  it('is off by default for a chat, can be switched on, and is sent with the message', async () => {
    const { fetch } = renderApp(<Chat />, { route: '/chat', user: userWith(PERMS), routes: { ...chatRoutes(status()), '/api/chat/turn': new Response('data: {"type":"done"}\n\n', { headers: { 'content-type': 'text/event-stream' } }) } });
    await openSettings();
    const toggle = await screen.findByLabelText('Web search');
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    expect(toggle).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.type(screen.getByLabelText('Message'), 'hello{Enter}');
    await waitFor(() => expect(fetch.calls.find((c) => c.url === '/api/chat/turn')?.body.webSearch).toBe(true));
  });

  it.each([
    [{ allowed: false }, /administrator has turned web search off/],
    [{ enabled: false }, /switched off in your profile/],
    [{ configured: false }, /No search service/],
  ])('is disabled when %o', async (over) => {
    renderApp(<Chat />, { route: '/chat', user: userWith(PERMS), routes: chatRoutes(status(over)) });
    await openSettings();
    await waitFor(() => expect(screen.getByLabelText('Web search')).toBeDisabled());
  });
});

describe('web search (profile)', () => {
  it('saves the profile switch', async () => {
    const { fetch } = renderApp(<Profile />, { route: '/profile/web-search', user: userWith(PERMS, { source: 'local' }), routes: { '/api/web-search': status(), 'PUT /api/web-search/settings': status({ enabled: false }) } });
    const sw = await screen.findByLabelText(/Let the model search the web/);
    await waitFor(() => expect(sw).toBeChecked());
    await userEvent.click(sw);
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'PUT')?.body).toEqual({ enabled: false }));
    await waitFor(() => expect(sw).not.toBeChecked());
  });

  it('tells the user when an administrator has it off', async () => {
    renderApp(<Profile />, { route: '/profile/web-search', user: userWith(PERMS, { source: 'local' }), routes: { '/api/web-search': status({ allowed: false }) } });
    expect(await screen.findByText(/administrator has turned web search off/)).toBeInTheDocument();
  });
});

describe('web search (admin page)', () => {
  const admin = () => userWith([...ALL, 'settings.read', 'settings.write'], { source: 'local' });
  const open = (service = { provider: '', url: '', allowPrivate: false, apiKeySet: false }, extra = {}) => renderApp(<Routes><Route path="/admin/*" element={<AdminLayout />} /></Routes>, { route: '/admin/web-search', user: admin(), routes: { '/api/admin/general': { webSearchAllowed: false }, '/api/admin/web-search': service, ...extra } });

  it('saves the Brave key write-only and never shows a saved key', async () => {
    const { fetch } = open({ provider: 'brave', url: '', allowPrivate: false, apiKeySet: true }, { 'PUT /api/admin/web-search': { provider: 'brave', url: '', allowPrivate: false, apiKeySet: true } });
    const key = await screen.findByLabelText(/API key/);
    expect(key).toHaveValue('');
    expect(key).toHaveAttribute('placeholder', expect.stringContaining('saved'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'PUT')?.body).toEqual({ provider: 'brave', url: '', allowPrivate: false })); // key omitted: keep the stored one
    await userEvent.type(key, 'new-key');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.calls.filter((c) => c.method === 'PUT').at(-1).body.apiKey).toBe('new-key'));
  });

  it('shows the SearXNG address fields and toggles the tenant switch', async () => {
    const { fetch } = open({ provider: 'searxng', url: 'https://searx.example.com', allowPrivate: false, apiKeySet: false }, { 'PUT /api/admin/general': { webSearchAllowed: true } });
    expect(await screen.findByLabelText(/SearXNG address/)).toHaveValue('https://searx.example.com');
    await userEvent.click(screen.getByLabelText(/Allow web search for this organization/));
    await waitFor(() => expect(fetch.calls.find((c) => c.url === '/api/admin/general' && c.method === 'PUT')?.body).toEqual({ webSearchAllowed: true }));
  });
});
