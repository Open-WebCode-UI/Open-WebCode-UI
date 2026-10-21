import { describe, it, expect, vi } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentPanel from '../src/components/AgentPanel.jsx';
import Servers from '../src/pages/admin/Servers.jsx';
import { renderApp, userWith, ALL, ADMIN } from './helpers.jsx';

const sse = (...evs) => new Response(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const MODELS = { '/api/models': { models: [{ id: 1, label: 'Fake', provider: 'p' }], defaults: {} }, '/api/skills': [] };
const run = async (turn) => {
  const r = renderApp(<AgentPanel project={{ id: 7 }} />, { user: userWith(ALL), routes: { ...MODELS, 'POST /api/agent/turn': turn } });
  await userEvent.type(await screen.findByLabelText('Message'), 'go'); await userEvent.click(screen.getByRole('button', { name: 'Send' })); return r;
};
const start = (id, o = {}) => ({ type: 'subagent_start', id, name: `job ${id}`, task: `Do task ${id}`, mode: 'plan', downgraded: false, ...o });
const inner = (id, event) => ({ type: 'subagent_event', id, event });

describe('subagent cards', () => {
  it('shows a subagent as one card (not as a spawn_agent tool step) with its mode and live activity', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const enc = new TextEncoder();
    await run(() => new Response(new ReadableStream({ async start(c) {
      const s = (e) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      s({ type: 'start', conversationId: 1 }); s({ type: 'tool_start', id: 'S1', name: 'spawn_agent', args: {} }); s(start('S1', { name: 'audit auth' }));
      s(inner('S1', { type: 'tool_start', id: 't1', name: 'read_file', args: { path: 'src/auth.js' } })); await gate;
      s(inner('S1', { type: 'tool_result', id: 't1', name: 'read_file', result: '1\tcode' })); s({ type: 'subagent_done', id: 'S1', status: 'complete', summary: 'Auth is **fine**.' }); s({ type: 'tool_result', id: 'S1', name: 'spawn_agent', result: 'ok' }); s({ type: 'done' }); c.close();
    } }), { headers: { 'content-type': 'text/event-stream' } }));
    const card = await screen.findByTestId('subagent');
    expect(card).toHaveAttribute('data-status', 'running'); expect(card).toHaveAttribute('data-mode', 'plan');
    expect(within(card).getByText('Subagent: audit auth')).toBeInTheDocument(); expect(within(card).getByText('read-only')).toBeInTheDocument(); expect(within(card).getByText('Reading src/auth.js')).toBeInTheDocument(); // live activity line
    expect(screen.queryAllByTestId('tool-card')).toHaveLength(0); // the spawn_agent call itself is not a generic step
    release();
    await waitFor(() => expect(card).toHaveAttribute('data-status', 'complete')); expect(within(card).getByText('Done')).toBeInTheDocument(); expect(within(card).queryByText('Reading src/auth.js')).toBeNull();
  });
  it('expands to show the task, the child\'s own steps as cards, and its report', async () => {
    await run(() => sse({ type: 'start', conversationId: 1 }, start('S2', { name: 'finder', task: 'Find the entry point.' }),
      inner('S2', { type: 'text', text: 'Looking around.' }), inner('S2', { type: 'tool_start', id: 'a', name: 'list_dir', args: { path: 'src' } }), inner('S2', { type: 'tool_result', id: 'a', name: 'list_dir', result: 'index.js' }),
      inner('S2', { type: 'tool_start', id: 'b', name: 'read_file', args: { path: 'src/index.js' } }), inner('S2', { type: 'tool_result', id: 'b', name: 'read_file', result: 'Error: no such file' }),
      { type: 'subagent_done', id: 'S2', status: 'partial', summary: 'Entry is **src/index.js** (unverified).' }, { type: 'done' }));
    const card = await screen.findByTestId('subagent'); await waitFor(() => expect(card).toHaveAttribute('data-status', 'partial')); expect(within(card).getByText('Partly done')).toBeInTheDocument();
    expect(within(card).queryByText('Find the entry point.')).toBeNull(); // collapsed by default
    await userEvent.click(within(card).getByRole('button', { name: 'Subagent finder' }));
    expect(within(card).getByText('Find the entry point.')).toBeVisible(); expect(within(card).getByText('Looking around.')).toBeInTheDocument();
    expect(within(card).getAllByTestId('tool-card').map((c) => c.dataset.tool)).toEqual(['list_dir', 'read_file']); expect(within(card).getAllByTestId('tool-card').map((c) => c.dataset.status)).toEqual(['ok', 'error']);
    expect(within(card).getByText('src/index.js').tagName).toBe('STRONG'); expect(within(card).getByText('Report')).toBeInTheDocument();
  });
  it('shows several subagents running side by side, each with its own steps', async () => {
    await run(() => sse({ type: 'start', conversationId: 1 }, start('P1'), start('P2'), start('P3'),
      inner('P2', { type: 'tool_start', id: 'x', name: 'search', args: { pattern: 'TODO' } }), inner('P1', { type: 'tool_start', id: 'y', name: 'list_dir', args: { path: '.' } }),
      { type: 'subagent_done', id: 'P3', status: 'blocked', summary: 'No access.' }, { type: 'done' }));
    const cards = await screen.findAllByTestId('subagent'); expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.dataset.status)).toEqual(['running', 'running', 'blocked']);
    expect(within(cards[0]).getByText('Listing .')).toBeInTheDocument(); expect(within(cards[1]).getByText(/Searching for/)).toBeInTheDocument(); expect(within(cards[2]).getByText('Blocked')).toBeInTheDocument();
  });
  it('marks act subagents as able to edit, and explains a downgrade to read-only', async () => {
    await run(() => sse({ type: 'start', conversationId: 1 }, start('A1', { mode: 'act' }), start('A2', { mode: 'plan', downgraded: true }), { type: 'done' }));
    const [act, ro] = await screen.findAllByTestId('subagent'); expect(act).toHaveAttribute('data-mode', 'act'); expect(within(act).getByText('can edit files')).toBeInTheDocument(); expect(within(ro).getByText('read-only')).toBeInTheDocument();
    await userEvent.click(within(ro).getByRole('button', { name: /Subagent/ })); expect(within(ro).getByText(/Edit mode was requested but is not allowed here/)).toBeInTheDocument();
  });
  it('subagent file edits still refresh the file tree', async () => {
    const onFileChanged = vi.fn();
    renderApp(<AgentPanel project={{ id: 7 }} onFileChanged={onFileChanged} />, { user: userWith(ALL), routes: { ...MODELS, 'POST /api/agent/turn': () => sse({ type: 'start', conversationId: 1 }, start('E1', { mode: 'act' }), inner('E1', { type: 'file_changed', path: 'src/new.js' }), { type: 'done' }) } });
    await userEvent.type(await screen.findByLabelText('Message'), 'go'); await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onFileChanged).toHaveBeenCalledWith('src/new.js'));
  });
  it('a command approval from a subagent names the subagent', async () => {
    const { approvals } = await import('../src/approvalStore.js'); approvals.clear();
    let answered; const gate = new Promise((r) => { answered = r; });
    renderApp(<AgentPanel project={{ id: 7 }} />, { user: userWith(ALL), routes: { ...MODELS, 'POST /api/agent/respond': () => { answered(); return { ok: true }; }, 'POST /api/agent/turn': () => new Response(new ReadableStream({ async start(c) {
      const enc = new TextEncoder(), s = (e) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); s({ type: 'start', conversationId: 1 }); s(start('C1', { mode: 'act', name: 'tester' })); s({ type: 'approval', id: 'ap', command: 'npm test', agent: 'tester' }); await gate; s({ type: 'done' }); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } }) } });
    await userEvent.type(await screen.findByLabelText('Message'), 'go'); await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Subagent “tester” wants to run this command/)).toBeInTheDocument(); expect(screen.getByText('npm test')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Allow' })); await waitFor(() => expect(screen.queryByTestId('approval')).toBeNull());
  });
});

describe('admin: subagent support per model', () => {
  const provider = { id: 4, name: 'Local', type: 'lmstudio', enabled: true, hasSecret: false, config: { baseUrl: 'http://localhost:1234/v1' }, allowedRoles: [],
    models: [{ id: 11, modelId: 'big', label: 'big', enabled: true, maxTokens: 4096, thinkingMode: 'off', subagents: true }, { id: 12, modelId: 'tiny', label: 'tiny', enabled: true, maxTokens: 4096, thinkingMode: 'off', subagents: false }] };
  const routes = { '/api/admin/providers': [provider], '/api/admin/roles': { roles: [], groupMap: [] }, '/api/models': { models: [], defaults: {} }, 'POST /api/admin/providers/4/models': provider };
  it('shows the switch in the model dialog and saves a change without touching other settings', async () => {
    const { fetch } = renderApp(<Servers />, { user: userWith(ADMIN), routes });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit tiny' }));
    expect(await screen.findByLabelText(/^Subagents/)).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Edit big' }));
    const sw = await screen.findByLabelText(/^Subagents/); expect(sw).toBeChecked();
    await userEvent.click(sw);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'POST' && c.body?.subagents === false).body).toMatchObject({ modelId: 'big', subagents: false, maxTokens: 4096, enabled: true }));
  });
  it('is read-only without provider.write', async () => { renderApp(<Servers />, { user: userWith([...ALL, 'provider.read']), routes }); await screen.findByText('big'); expect(screen.queryByRole('button', { name: 'Edit big' })).toBeNull(); });
});
