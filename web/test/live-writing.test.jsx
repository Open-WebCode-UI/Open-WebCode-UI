import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, userWith, ALL } from './helpers.jsx';
import { withPending } from '../src/components/pathUtils.js';

vi.mock('@monaco-editor/react', () => ({ default: ({ value, options }) => <pre data-testid="monaco" data-readonly={String(!!options?.readOnly)}>{value}</pre>, DiffEditor: () => <div /> }));
const { default: IDE } = await import('../src/pages/IDE.jsx');

const enc = new TextEncoder();
beforeEach(() => localStorage.clear());

describe('withPending', () => {
  it('adds unsaved files and their missing folders, without touching the original tree or existing files', () => {
    const tree = [{ name: 'a.js', path: 'a.js', type: 'file' }, { name: 'src', path: 'src', type: 'dir', children: [] }];
    const out = withPending(tree, ['src/ui/x.js', 'a.js']);
    expect(out[1].children[0]).toMatchObject({ name: 'ui', type: 'dir', pending: true });
    expect(out[1].children[0].children[0]).toMatchObject({ path: 'src/ui/x.js', type: 'file', pending: true });
    expect(out[0].pending).toBeUndefined(); expect(tree[1].children).toEqual([]);
  });
});

describe('files appear while the agent is still writing them', () => {
  it('lists the new file in the Explorer and fills the Editor as the content streams, then settles on the saved file', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const turn = () => new Response(new ReadableStream({
      async start(c) {
        const send = (e) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        send({ type: 'start', conversationId: 5 });
        send({ type: 'tool_progress', id: 't1', name: 'write_file', fields: {} });
        send({ type: 'tool_progress', id: 't1', name: 'write_file', fields: { path: 'src/hello.js' }, closed: ['path'] });
        send({ type: 'tool_progress', id: 't1', name: 'write_file', fields: { content: 'const a = 1;\nconst b' }, closed: ['path'] });
        await gate;
        send({ type: 'tool_start', id: 't1', name: 'write_file', args: { path: 'src/hello.js', bytes: 28 } });
        send({ type: 'tool_result', id: 't1', name: 'write_file', result: 'Wrote src/hello.js' });
        send({ type: 'file_changed', path: 'src/hello.js' });
        send({ type: 'done' }); c.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
    let written = false;
    const routes = {
      '/api/projects': [{ id: 1, name: 'demo' }], '/api/projects/1/checkpoints': [], '/api/models': { models: [{ id: 1, label: 'Fake', provider: 'p' }], defaults: {} }, '/api/skills': [], 'POST /api/agent/turn': turn,
      '/api/projects/1/tree': () => (written ? [{ name: 'src', path: 'src', type: 'dir', children: [{ name: 'hello.js', path: 'src/hello.js', type: 'file' }] }] : []),
      '/api/projects/1/file': () => ({ content: 'const a = 1;\nconst b = 2;\n' }),
    };
    renderApp(<IDE />, { user: userWith(ALL), routes });
    await userEvent.type(await screen.findByLabelText('Message', {}, { timeout: 4000 }), 'make hello'); await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    // mid-write: not on disk yet, but already in the Explorer and the Editor
    const row = await screen.findByTestId('node-src/hello.js', {}, { timeout: 4000 });
    expect(within(row).getByLabelText('Writing hello.js')).toBeInTheDocument();
    expect(await screen.findByText('✎ writing…', { exact: false })).toBeInTheDocument();
    expect(screen.getByTestId('monaco')).toHaveTextContent(/const a = 1;\s*const b$/); expect(screen.getByTestId('monaco')).toHaveAttribute('data-readonly', 'true');
    written = true; release();
    await waitFor(() => expect(screen.getByTestId('monaco')).toHaveTextContent('const b = 2;'), { timeout: 4000 }); // reloaded from disk
    expect(screen.getByTestId('monaco')).toHaveAttribute('data-readonly', 'false'); expect(screen.queryByText('✎ writing…', { exact: false })).toBeNull();
  });
});

describe('line edits', () => {
  it('previews replace_lines in the Editor while the call streams, then settles on the saved file', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const turn = () => new Response(new ReadableStream({
      async start(c) {
        const send = (e) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        send({ type: 'start', conversationId: 6 });
        send({ type: 'tool_progress', id: 'l1', name: 'replace_lines', fields: {} });
        send({ type: 'tool_progress', id: 'l1', name: 'replace_lines', fields: { path: 'a.js', start_line: '2' }, closed: ['path'] });
        send({ type: 'tool_progress', id: 'l1', name: 'replace_lines', fields: { content: 'TWO' }, closed: ['path', 'start_line'] });
        await gate;
        send({ type: 'tool_start', id: 'l1', name: 'replace_lines', args: { path: 'a.js', start_line: 2, content: 'TWO' } });
        send({ type: 'tool_result', id: 'l1', name: 'replace_lines', result: 'Replaced 1 line (from line 2) with 1 line in a.js' });
        send({ type: 'file_changed', path: 'a.js' });
        send({ type: 'done' }); c.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
    let written = false;
    const routes = {
      '/api/projects': [{ id: 1, name: 'demo' }], '/api/projects/1/checkpoints': [], '/api/models': { models: [{ id: 1, label: 'Fake', provider: 'p' }], defaults: {} }, '/api/skills': [], 'POST /api/agent/turn': turn,
      '/api/projects/1/tree': [{ name: 'a.js', path: 'a.js', type: 'file' }],
      '/api/projects/1/file': () => ({ content: written ? 'one\nTWO\nthree\n' : 'one\ntwo\nthree\n' }),
    };
    renderApp(<IDE />, { user: userWith(ALL), routes });
    await userEvent.type(await screen.findByLabelText('Message', {}, { timeout: 4000 }), 'edit it'); await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByTestId('monaco')).toHaveTextContent(/one\s*TWO\s*three/), { timeout: 4000 });
    expect(screen.getByTestId('monaco')).toHaveAttribute('data-readonly', 'true');
    written = true; release();
    await waitFor(() => expect(screen.getByTestId('monaco')).toHaveAttribute('data-readonly', 'false'), { timeout: 4000 });
    expect(screen.getByTestId('monaco')).toHaveTextContent(/one\s*TWO\s*three/);
  });
});

describe('plans', () => {
  it('shows the plan as it is written, then turns it into the approvable plan', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const turn = () => new Response(new ReadableStream({
      async start(c) {
        const send = (e) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        send({ type: 'start', conversationId: 6 });
        send({ type: 'tool_progress', id: 'p1', name: 'propose_plan', fields: {} });
        send({ type: 'tool_progress', id: 'p1', name: 'propose_plan', fields: { plan: '## Steps\n1. Add the login form' } });
        await gate;
        send({ type: 'tool_start', id: 'p1', name: 'propose_plan', args: {} });
        send({ type: 'plan', plan: '## Steps\n1. Add the login form\n2. Test it' });
        send({ type: 'tool_result', id: 'p1', name: 'propose_plan', result: 'ok' });
        send({ type: 'done' }); c.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
    renderApp(<IDE />, { user: userWith(ALL), routes: { '/api/projects': [{ id: 1, name: 'demo' }], '/api/projects/1/tree': [], '/api/projects/1/checkpoints': [], '/api/models': { models: [{ id: 1, label: 'Fake', provider: 'p' }], defaults: {} }, '/api/skills': [], 'POST /api/agent/turn': turn } });
    await userEvent.type(await screen.findByLabelText('Message', {}, { timeout: 4000 }), 'plan it'); await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const card = await screen.findByTestId('plan-card', {}, { timeout: 4000 });
    expect(within(card).getByText('Writing plan…')).toBeInTheDocument(); expect(within(card).getByText(/Add the login form/)).toBeInTheDocument(); expect(within(card).queryByRole('button')).toBeNull();
    release();
    expect(await within(card).findByText('Proposed plan', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getAllByTestId('plan-card')).toHaveLength(1); expect(within(card).getByText(/Test it/)).toBeInTheDocument(); expect(within(card).getByRole('button', { name: /Approve/ })).toBeEnabled();
  });
});
