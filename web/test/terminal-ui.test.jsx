import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import { buildTheme, DEFAULT_BRANDING } from '../src/theme.js';
import { approvals } from '../src/approvalStore.js';
import { renderApp, userWith, SHELL, ALL, mockFetch } from './helpers.jsx';

// ---- fakes for xterm and WebSocket
const terms = [];
vi.mock('@xterm/xterm', () => ({ Terminal: class { constructor(o) { this.opts = o; this.cols = 90; this.rows = 20; this.written = []; this.disposed = false; terms.push(this); } loadAddon() {} open(el) { this.el = el; } write(d) { this.written.push(d); } onData(cb) { this.data = cb; return { dispose: () => { this.data = null; } }; } focus() { this.focused = true; } dispose() { this.disposed = true; } } }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
const sockets = [];
class FakeSocket { constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); } send(d) { this.sent.push(JSON.parse(d)); } close() { this.closed = true; this.readyState = 3; } open() { this.readyState = 1; this.onopen?.(); } msg(m) { this.onmessage?.({ data: JSON.stringify(m) }); } drop() { this.readyState = 3; this.onclose?.(); } }
const { default: TerminalPanel } = await import('../src/components/ide/TerminalPanel.jsx');
const { default: ShellTerminal } = await import('../src/components/ide/ShellTerminal.jsx');
const { default: AgentPanel } = await import('../src/components/AgentPanel.jsx');

beforeEach(() => { terms.length = 0; sockets.length = 0; vi.stubGlobal('WebSocket', FakeSocket); approvals.clear(); });
afterEach(() => vi.unstubAllGlobals());
const wrap = (ui) => render(<ThemeProvider theme={buildTheme(DEFAULT_BRANDING)}>{ui}</ThemeProvider>);

describe('ShellTerminal (xterm over WebSocket)', () => {
  it('connects to the session, shows output, and sends what you type', () => {
    wrap(<ShellTerminal sessionId="abc123" />);
    expect(sockets[0].url).toMatch(/^wss?:\/\/[^/]+\/api\/terminal\/ws\?id=abc123$/);
    act(() => sockets[0].open());
    expect(terms[0].focused).toBe(true); expect(sockets[0].sent[0]).toEqual({ type: 'resize', cols: 90, rows: 20 });
    act(() => sockets[0].msg({ type: 'output', data: 'hello\r\n' })); expect(terms[0].written).toContain('hello\r\n');
    terms[0].data('ls\r'); expect(sockets[0].sent.at(-1)).toEqual({ type: 'input', data: 'ls\r' });
  });
  it('is view-only for the agent\'s shell: stdin disabled and nothing is sent', () => {
    wrap(<ShellTerminal sessionId="agent1" readOnly />);
    act(() => sockets[0].open()); expect(terms[0].opts.disableStdin).toBe(true); expect(terms[0].data).toBeFalsy();
    expect(sockets[0].sent.every((m) => m.type === 'resize')).toBe(true);
  });
  it('reports when the shell exits and when access is revoked', () => {
    const onEnded = vi.fn(); wrap(<ShellTerminal sessionId="x" onEnded={onEnded} />); act(() => sockets[0].open());
    act(() => sockets[0].msg({ type: 'exit', code: 0 })); expect(onEnded).toHaveBeenCalledWith(0); expect(terms[0].written.join('')).toContain('shell exited');
    act(() => { sockets[0].msg({ type: 'closed', reason: 'access_revoked' }); sockets[0].drop(); });
    expect(screen.getByText('Your access to the terminal ended.')).toBeInTheDocument();
  });
  it('offers to reconnect after a dropped connection', async () => {
    wrap(<ShellTerminal sessionId="x" />); act(() => sockets[0].open()); act(() => sockets[0].drop());
    expect(screen.getByText('Disconnected')).toBeInTheDocument(); await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(sockets).toHaveLength(2); expect(terms[0].disposed).toBe(true);
  });
  it('cleans up the socket and terminal on unmount', () => { const { unmount } = wrap(<ShellTerminal sessionId="x" />); act(() => sockets[0].open()); unmount(); expect(sockets[0].closed).toBe(true); expect(terms[0].disposed).toBe(true); });
});

describe('Terminal pane', () => {
  const status = (o) => ({ enabled: true, canUse: true, canView: true, userSession: null, agentSession: null, ...o });
  const pane = (st, routes = {}, user = userWith(SHELL)) => renderApp(<TerminalPanel project={{ id: 3 }} refreshKey={0} />, { user, routes: { '/api/terminal/status': st, ...routes } });

  it('explains when shell access is switched off', async () => { pane(status({ enabled: false, canUse: false, canView: false })); expect(await screen.findByText(/Shell access is turned off/)).toBeInTheDocument(); });
  it('explains when the role lacks the permission', async () => { pane(status({ canUse: false })); expect(await screen.findByText(/cannot use the interactive terminal/)).toBeInTheDocument(); });
  it('starts a terminal on demand and then attaches to it', async () => {
    let started = false;
    const { fetch } = pane(() => status({ userSession: started ? 'sess1' : null }), { 'POST /api/terminal/sessions': () => { started = true; return { id: 'sess1' }; } });
    await userEvent.click(await screen.findByRole('button', { name: 'Start terminal' }));
    await waitFor(() => expect(sockets).toHaveLength(1)); expect(sockets[0].url).toContain('id=sess1');
    expect(fetch.calls.find((c) => c.method === 'POST' && c.url === '/api/terminal/sessions').body).toEqual({ projectId: 3 });
  });
  it('re-attaches to a running terminal after a page reload (scrollback is replayed by the server)', async () => { pane(status({ userSession: 'live1' })); await waitFor(() => expect(sockets).toHaveLength(1)); expect(sockets[0].url).toContain('id=live1'); });
  it('asks for re-verification (step-up) before opening a shell, then retries', async () => {
    let n = 0; const { fetch } = pane(() => status({ userSession: n >= 2 ? 's' : null }), {
      'POST /api/terminal/sessions': () => { n += 1; return n === 1 ? new Response(JSON.stringify({ error: 'mfa_required', method: 'local' }), { status: 403 }) : { id: 's' }; }, 'POST /api/auth/stepup': { ok: true } });
    await userEvent.click(await screen.findByRole('button', { name: 'Start terminal' }));
    await userEvent.type(await screen.findByLabelText('Authentication code'), '123456'); await userEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(fetch.calls.filter((c) => c.url === '/api/terminal/sessions')).toHaveLength(2));
  });
  it('shows the agent tab: a notice before the first command, then a live read-only view', async () => {
    const { rerender } = pane(status({ agentSession: null }));
    await userEvent.click(await screen.findByRole('tab', { name: 'Agent' })); expect(await screen.findByText(/has not run any commands/)).toBeInTheDocument();
    expect(sockets).toHaveLength(0);
  });
  it('attaches read-only to the agent shell once it exists', async () => {
    pane(status({ agentSession: 'agentsess' })); await userEvent.click(await screen.findByRole('tab', { name: 'Agent' }));
    await waitFor(() => expect(sockets).toHaveLength(1)); expect(sockets[0].url).toContain('id=agentsess'); expect(terms[0].opts.disableStdin).toBe(true);
  });
  it('closes the terminal on request', async () => {
    const { fetch } = pane(status({ userSession: 'live2' }), { 'DELETE /api/terminal/sessions/live2': { ok: true } });
    await userEvent.click(await screen.findByRole('button', { name: 'Close terminal' })); await waitFor(() => expect(fetch.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/live2'))).toBe(true));
  });
});

describe('command approval (Allow / Deny)', () => {
  it('shows what the agent wants to run in the terminal pane; Allow and Deny answer the agent', async () => {
    const { fetch } = renderApp(<TerminalPanel project={{ id: 3 }} refreshKey={0} />, { user: userWith(SHELL), routes: { '/api/terminal/status': { enabled: true, canUse: true, canView: true, userSession: null, agentSession: null }, 'POST /api/agent/respond': { ok: true } } });
    await screen.findByRole('button', { name: 'Start terminal' });
    act(() => approvals.push({ id: 'a1', command: 'rm -rf build' }));
    const box = await screen.findByTestId('approval'); expect(within(box).getByText('rm -rf build')).toBeInTheDocument(); expect(within(box).getByText(/The agent wants to run this command/)).toBeInTheDocument();
    await userEvent.click(within(box).getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.url === '/api/agent/respond').body).toEqual({ id: 'a1', value: false }));
    expect(screen.queryByTestId('approval')).toBeNull();
    act(() => approvals.push({ id: 'a2', command: 'npm test', agent: 'tester' }));
    expect(await screen.findByText(/Subagent “tester” wants to run/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(fetch.calls.filter((c) => c.url === '/api/agent/respond').at(-1).body).toEqual({ id: 'a2', value: true }));
    act(() => approvals.push({ id: 'a3', command: 'npm i' }));
    await userEvent.type(await screen.findByLabelText('Message to the agent'), '  use npm ci  ');
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(fetch.calls.filter((c) => c.url === '/api/agent/respond').at(-1).body).toEqual({ id: 'a3', value: false, message: 'use npm ci' }));
  });
  it('queues several requests and shows them one at a time', async () => {
    mockFetch({ 'POST /api/agent/respond': { ok: true } }); wrap(<AgentPanelProbe />);
    act(() => { approvals.push({ id: 'q1', command: 'first' }); approvals.push({ id: 'q2', command: 'second' }); approvals.push({ id: 'q1', command: 'first' }); }); // duplicate ignored
    const box = await screen.findByTestId('approval'); expect(within(box).getByText('first')).toBeInTheDocument(); expect(within(box).getByText(/\(\+1 more waiting\)/)).toBeInTheDocument();
    await userEvent.click(within(box).getByRole('button', { name: 'Allow' })); expect(await screen.findByText('second')).toBeInTheDocument();
  });
  it('the chat panel and the terminal pane share one prompt: answering in either clears both', async () => {
    let answered; const gate = new Promise((r) => { answered = r; }); // the real stream stays open until the user decides
    const turn = () => new Response(new ReadableStream({ async start(c) {
      const enc = new TextEncoder(), send = (e) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      send({ type: 'start', conversationId: 1 }); send({ type: 'approval', id: 'ap9', command: 'make deploy' }); await gate; send({ type: 'done' }); c.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
    const { fetch } = renderApp(<><AgentPanel project={{ id: 3 }} /><TerminalPanel project={{ id: 3 }} refreshKey={0} /></>, { user: userWith(SHELL), routes: { '/api/models': { models: [{ id: 1, label: 'M', provider: 'p' }], defaults: {} }, '/api/skills': [], 'POST /api/agent/turn': turn, 'POST /api/agent/respond': () => { answered(); return { ok: true }; },
      '/api/terminal/status': { enabled: true, canUse: true, canView: true, userSession: null, agentSession: null } } });
    await userEvent.type(await screen.findByLabelText('Message'), 'deploy'); await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getAllByTestId('approval')).toHaveLength(2)); // one in the chat, one in the terminal pane
    await userEvent.click(within(screen.getAllByTestId('approval')[1]).getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(screen.queryAllByTestId('approval')).toHaveLength(0));
    expect(fetch.calls.filter((c) => c.url === '/api/agent/respond')).toHaveLength(1);
  });
});
function AgentPanelProbe() { return <ApprovalProbe />; }
import ApprovalPrompt from '../src/components/ApprovalPrompt.jsx';
const ApprovalProbe = () => <ApprovalPrompt />;
