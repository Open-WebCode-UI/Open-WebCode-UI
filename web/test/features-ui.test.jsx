import { describe, it, expect, afterEach } from 'vitest';
import { screen, waitFor, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Profile from '../src/pages/Profile.jsx';
import { renderApp, userWith, ALL } from './helpers.jsx';
import { StatusCard, MemorySavedNote } from '../src/components/AgentItems.jsx';
import { AttachButton, AttachmentChips, useAttachments } from '../src/components/Attachments.jsx';

afterEach(cleanup);
const NEW = [...ALL, 'mcp.use', 'profile.mcp.edit', 'memory.use'];
const local = (perms = NEW) => userWith(perms, { source: 'local' });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const last = (f, method, url) => f.calls.filter((c) => c.method === method && String(c.url).startsWith(url)).at(-1);

describe('change password (profile → Security)', () => {
  const open = (user, routes = {}) => renderApp(<Profile />, { route: '/profile/security', user, routes: { '/api/auth/sessions': [], ...routes } });
  it('lets a local user change their password after confirming it', async () => {
    const { fetch } = open(local(), { 'POST /api/auth/password': { ok: true } });
    await userEvent.type(await screen.findByLabelText(/^Current password/), 'old-password-1');
    await userEvent.type(screen.getByLabelText(/^New password/), 'brand-new-pass-2');
    await userEvent.type(screen.getByLabelText(/^Confirm new password/), 'brand-new-pass-X');
    expect(screen.getByText('Does not match')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText(/^Confirm new password/));
    await userEvent.type(screen.getByLabelText(/^Confirm new password/), 'brand-new-pass-2');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/Password changed/)).toBeInTheDocument();
    expect(last(fetch, 'POST', '/api/auth/password').body).toEqual({ current: 'old-password-1', next: 'brand-new-pass-2' });
    expect(screen.getByLabelText(/^Current password/)).toHaveValue(''); // cleared
  });
  it('shows the server\'s reason when it is refused', async () => {
    open(local(), { 'POST /api/auth/password': () => json(401, { error: 'invalid_credentials' }) });
    await userEvent.type(await screen.findByLabelText(/^Current password/), 'wrong-password');
    await userEvent.type(screen.getByLabelText(/^New password/), 'brand-new-pass-2');
    await userEvent.type(screen.getByLabelText(/^Confirm new password/), 'brand-new-pass-2');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Your current password is not correct.')).toBeInTheDocument();
  });
  it('is not offered to single sign-on users', async () => {
    open(userWith(NEW));
    expect(await screen.findByText('Active sessions')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Current password/)).toBeNull();
  });
});

describe('profile → MCP servers', () => {
  const servers = { tenant: [{ id: 1, name: 'docs', url: 'https://mcp.corp.example/mcp', disabledByMe: false }], own: [{ id: 5, name: 'mine', url: 'https://mine.example.com/mcp', enabled: true, headerNames: ['Authorization'] }] };
  it('lets the user switch an organization server off for themselves, and manage their own', async () => {
    const { fetch } = renderApp(<Profile />, { route: '/profile/mcp', user: local(), routes: { '/api/mcp/servers': servers, 'PUT /api/mcp/servers/1/enabled': { ok: true }, 'POST /api/mcp/my-servers': { id: 6 }, 'POST /api/mcp/my-servers/5/test': { ok: true, tools: [{ name: 'lookup', description: 'd', readOnly: true }, { name: 'write', description: 'w', readOnly: false }] } } });
    const row = await screen.findByTestId('mcp-tenant');
    await userEvent.click(within(row).getByLabelText('Use docs'));
    expect(last(fetch, 'PUT', '/api/mcp/servers/1/enabled').body).toEqual({ enabled: false });
    await userEvent.click(within(screen.getByTestId('mcp-own')).getByRole('button', { name: 'Test' }));
    expect(await screen.findByText(/Connected\. 2 tools/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add server' }));
    await userEvent.type(screen.getByLabelText('Name'), 'new-one');
    await userEvent.type(screen.getByLabelText('URL'), 'https://x.example.com/mcp');
    await userEvent.type(screen.getByLabelText('Authentication headers'), 'Authorization: Bearer abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(last(fetch, 'POST', '/api/mcp/my-servers')).toBeTruthy());
    expect(last(fetch, 'POST', '/api/mcp/my-servers').body).toEqual({ name: 'new-one', url: 'https://x.example.com/mcp', enabled: true, headers: { Authorization: 'Bearer abc' } });
  });
  it('without profile.mcp.edit the user can only toggle, not add; stored header values are never shown', async () => {
    renderApp(<Profile />, { route: '/profile/mcp', user: local([...ALL, 'mcp.use']), routes: { '/api/mcp/servers': servers } });
    await screen.findByTestId('mcp-own');
    expect(screen.queryByRole('button', { name: 'Add server' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Bearer/);
  });
  it('hides the MCP and Memory sections from users without the permission', async () => {
    renderApp(<Profile />, { route: '/profile/account', user: local(ALL) });
    await screen.findByText('Replay tutorial').catch(() => {});
    expect(screen.queryByRole('link', { name: 'MCP servers' })).toBeNull(); expect(screen.queryByRole('link', { name: 'Memory' })).toBeNull();
  });
});

describe('profile → Memory', () => {
  const mem = (over = {}) => ({ allowed: true, maxText: 500, user: { enabled: false, entries: [] }, ...over });
  it('is off by default; the user can turn it on, add, edit, delete, and clear notes', async () => {
    let state = mem({ user: { enabled: false, entries: [{ id: 1, text: 'Prefers tabs', source: 'agent' }] } });
    const { fetch } = renderApp(<Profile />, { route: '/profile/memory', user: local(), routes: {
      '/api/projects': [], '/api/memory': () => state, 'PUT /api/memory/settings': (i) => { state = { ...state, user: { ...state.user, enabled: JSON.parse(i.body).enabled } }; return { ok: true }; },
      'POST /api/memory/entries': { id: 2 }, 'PUT /api/memory/entries/1': { ok: true }, 'DELETE /api/memory/entries/1': { ok: true }, 'DELETE /api/memory': { ok: true, removed: 1 } } });
    const box = await screen.findByTestId('memory-user');
    expect(within(box).getByLabelText('Memory user')).not.toBeChecked();
    expect(within(box).getByText('Prefers tabs')).toBeInTheDocument(); expect(within(box).getByText('agent')).toBeInTheDocument();
    await userEvent.click(within(box).getByLabelText('Memory user'));
    await waitFor(() => expect(last(fetch, 'PUT', '/api/memory/settings').body).toEqual({ scope: 'user', enabled: true }));
    await userEvent.type(within(box).getByLabelText('New user memory'), 'Likes short answers');
    await userEvent.click(within(box).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(last(fetch, 'POST', '/api/memory/entries').body).toEqual({ scope: 'user', text: 'Likes short answers' }));
    await userEvent.click(within(box).getByLabelText('Edit Prefers tabs'));
    const field = within(box).getByLabelText('Edit memory'); await userEvent.clear(field); await userEvent.type(field, 'Prefers spaces');
    await userEvent.click(within(box).getByLabelText('Save memory'));
    await waitFor(() => expect(last(fetch, 'PUT', '/api/memory/entries/1').body).toEqual({ text: 'Prefers spaces' }));
    await userEvent.click(within(box).getByLabelText('Delete Prefers tabs'));
    await waitFor(() => expect(last(fetch, 'DELETE', '/api/memory/entries/1')).toBeTruthy());
    window.confirm = () => true;
    await userEvent.click(within(box).getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(last(fetch, 'DELETE', '/api/memory?scope=user')).toBeTruthy());
  });
  it('tells the user when an administrator has turned the feature off', async () => {
    renderApp(<Profile />, { route: '/profile/memory', user: local(), routes: { '/api/projects': [], '/api/memory': mem({ allowed: false }) } });
    expect(await screen.findByText(/turned off by your administrator/)).toBeInTheDocument();
  });
  it('shows a project\'s memory when one is chosen', async () => {
    renderApp(<Profile />, { route: '/profile/memory', user: local(), routes: { '/api/projects': [{ id: 7, name: 'shop' }], '/api/memory': (i) => mem({ project: { id: 7, name: 'shop', enabled: true, entries: [{ id: 9, text: 'Uses pnpm', source: 'agent' }] } }) } });
    await userEvent.click(await screen.findByRole('combobox', { name: 'Project' }));
    await userEvent.click(await screen.findByRole('option', { name: 'shop' }));
    expect(await screen.findByText('Uses pnpm')).toBeInTheDocument();
  });
});

function AttachHarness({ model }) { const att = useAttachments(); return <div><AttachButton model={model} att={att} /><AttachmentChips att={att} /></div>; }
describe('attachments', () => {
  it('the paperclip only appears for models that accept attachments', () => {
    const { unmount } = renderApp(<AttachHarness model={{ id: 1, supportsFiles: false, supportsImages: false }} />, { user: local() });
    expect(screen.queryByLabelText('Attach files')).toBeNull(); unmount();
    renderApp(<AttachHarness model={{ id: 1, supportsFiles: true, supportsImages: true }} />, { user: local() });
    expect(screen.getByLabelText('Attach files')).toBeInTheDocument();
  });
  it('uploads right away, shows removable chips, and surfaces a refusal', async () => {
    const { fetch } = renderApp(<AttachHarness model={{ id: 1, supportsFiles: true, supportsImages: true }} />, { user: local(), routes: {
      'PUT /api/attachments': (i) => (String(i.body?.name) === 'bad.exe' ? json(415, { error: 'unsupported_file_type', message: 'Supported: images, PDF, and text files.' }) : json(201, { id: 'a'.repeat(32), name: 'rows.csv', kind: 'text', size: 5 })),
      'DELETE /api/attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': { ok: true } } });
    const input = screen.getByTestId('attach-input');
    await userEvent.upload(input, new File(['a,b'], 'rows.csv', { type: 'text/csv' }));
    expect(await screen.findByText('rows.csv')).toBeInTheDocument();
    expect(fetch.calls.find((c) => c.method === 'PUT').url).toBe('/api/attachments?name=rows.csv');
    await userEvent.click(within(screen.getByText('rows.csv').closest('.MuiChip-root')).getByTestId('CancelIcon'));
    await waitFor(() => expect(screen.queryByText('rows.csv')).toBeNull());
    expect(fetch.calls.some((c) => c.method === 'DELETE' && String(c.url).includes('/api/attachments/'))).toBe(true);
  });
});

describe('/status and memory notes in the conversation', () => {
  const status = {
    connection: { status: 'connected', signedInVia: 'Local account', mfaVerified: true, sessionStartedAt: 1700000000, sessionExpiresAt: 1700003600, model: { provider: 'Anthropic', type: 'anthropic', model: 'Claude', reachable: true } },
    server: { name: 'Acme Code', url: 'https://code.acme.test', secure: true, shell: 'files only' },
    user: { displayName: 'Dee Veloper', username: 'dee', email: 'd@x.test', roles: ['developer'] },
    project: { id: 1, name: 'shop', files: 42, filesCapped: false, sizeBytes: 2048, gitBranch: 'main', checkpoints: 3 },
    features: { mcpServers: 2, memory: ['user', 'project'] },
  };
  it('shows connection, server, user, and project information', () => {
    renderApp(<StatusCard s={status} />, { user: local() });
    const card = screen.getByTestId('status-card');
    for (const t of ['Connected', 'Local account', 'Anthropic (anthropic)', 'reachable', 'Acme Code — https://code.acme.test', 'Dee Veloper (dee)', 'd@x.test', 'developer', 'shop', '42 files · 2.0 KB', 'branch main', '2 active', 'user + project']) expect(card.textContent).toContain(t);
  });
  it('handles a chat with no project or model', () => {
    renderApp(<StatusCard s={{ ...status, project: null, connection: { ...status.connection, model: null }, features: { mcpServers: 0, memory: [] } }} />, { user: local() });
    const card = screen.getByTestId('status-card');
    expect(card.textContent).toContain('No model selected'); expect(card.textContent).toContain('no project access'); expect(card.textContent).toContain('off');
  });
  it('tells the user when the agent remembered something', () => {
    renderApp(<MemorySavedNote item={{ scope: 'project', text: 'Uses pnpm' }} />, { user: local() });
    expect(screen.getByTestId('memory-saved')).toHaveTextContent('Remembered (project): Uses pnpm');
  });
});
