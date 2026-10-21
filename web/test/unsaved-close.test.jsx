import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, userWith, ALL } from './helpers.jsx';

vi.mock('@monaco-editor/react', () => ({ default: (p) => <textarea data-testid="monaco" value={p.value} onChange={(e) => p.onChange?.(e.target.value)} />, DiffEditor: () => <div /> }));
vi.mock('@xterm/xterm', () => ({ Terminal: class { loadAddon() {} open() {} write() {} onData() { return { dispose() {} }; } dispose() {} } }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
const { default: IDE } = await import('../src/pages/IDE.jsx');

const TREE = [{ name: 'a.js', path: 'a.js', type: 'file' }, { name: 'b.js', path: 'b.js', type: 'file' }];
const ide = (routes = {}) => renderApp(<IDE />, { user: userWith(ALL), routes: {
  '/api/projects': [{ id: 1, name: 'demo' }], '/api/projects/1/tree': TREE, '/api/projects/1/checkpoints': [], '/api/models': { models: [], defaults: {} }, '/api/skills': [], '/api/terminal/status': { enabled: false },
  '/api/projects/1/file': { content: 'one' }, 'PUT /api/projects/1/file': { ok: true }, ...routes } });
const puts = (f) => f.calls.filter((c) => c.method === 'PUT' && /\/file/.test(c.url));
const openDirty = async (name) => {
  await userEvent.click(await screen.findByText(name)); await screen.findByRole('button', { name: `Close ${name}` });
  fireEvent.change(await screen.findByTestId('monaco'), { target: { value: 'edited' } });
};
const tabOpen = (name) => screen.queryByRole('button', { name: `Close ${name}` });
beforeEach(() => localStorage.clear());

describe('closing a tab with unsaved changes', () => {
  it('closes a clean tab straight away', async () => {
    ide(); await userEvent.click(await screen.findByText('a.js')); await userEvent.click(await screen.findByRole('button', { name: 'Close a.js' }));
    expect(screen.queryByRole('dialog')).toBeNull(); await waitFor(() => expect(tabOpen('a.js')).toBeNull());
  });
  it('asks first; Cancel keeps the tab and its edits', async () => {
    ide(); await openDirty('a.js'); await userEvent.click(screen.getByRole('button', { name: 'Close a.js' }));
    expect(await screen.findByText(/save the changes you made to a\.js/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(tabOpen('a.js')).not.toBeNull(); expect(screen.getByTestId('monaco')).toHaveValue('edited');
  });
  it('Save writes the file, then closes the tab', async () => {
    const { fetch } = ide(); await openDirty('a.js'); await userEvent.click(screen.getByRole('button', { name: 'Close a.js' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(tabOpen('a.js')).toBeNull()); expect(puts(fetch)[0].body).toEqual({ path: 'a.js', content: 'edited' });
  });
  it("Don't save closes the tab without writing", async () => {
    const { fetch } = ide(); await openDirty('a.js'); await userEvent.click(screen.getByRole('button', { name: 'Close a.js' }));
    await userEvent.click(await screen.findByRole('button', { name: "Don't save" }));
    await waitFor(() => expect(tabOpen('a.js')).toBeNull()); expect(puts(fetch)).toHaveLength(0);
  });
  it('a failed save keeps the tab open', async () => {
    ide({ 'PUT /api/projects/1/file': () => new Response('{}', { status: 500 }) }); await openDirty('a.js'); await userEvent.click(screen.getByRole('button', { name: 'Close a.js' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Save failed')).toBeInTheDocument(); expect(tabOpen('a.js')).not.toBeNull();
  });
  it('Close all tabs lists the unsaved files once', async () => {
    ide(); await userEvent.click(await screen.findByText('b.js')); await screen.findByRole('button', { name: 'Close b.js' });
    await openDirty('a.js');
    await userEvent.click(screen.getByRole('button', { name: 'File' })); await userEvent.click(screen.getByRole('menuitem', { name: /Close all tabs/ }));
    expect(await screen.findByText(/save the changes you made to a\.js/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: "Don't save" })); await waitFor(() => expect(tabOpen('b.js')).toBeNull()); expect(tabOpen('a.js')).toBeNull();
  });
});
