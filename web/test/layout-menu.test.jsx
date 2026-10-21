import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AppLayout from '../src/components/Layout.jsx';
import { layoutStore } from '../src/layoutStore.js';
import { PRESETS, DEFAULT_LAYOUT, visiblePanes, applyPreset } from '../src/components/ide/layout.js';
import { renderApp, userWith, ALL } from './helpers.jsx';

vi.mock('@monaco-editor/react', () => ({ default: () => <div data-testid="monaco" />, DiffEditor: () => <div /> }));
vi.mock('@xterm/xterm', () => ({ Terminal: class { loadAddon() {} open() {} write() {} onData() { return { dispose() {} }; } dispose() {} } }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
const { default: IDE } = await import('../src/pages/IDE.jsx');

const header = (route = '/', user = userWith(ALL)) => renderApp(<AppLayout><div>page</div></AppLayout>, { user, route });
const workspace = () => renderApp(<AppLayout><IDE /></AppLayout>, { user: userWith(ALL), routes: { '/api/projects': [{ id: 1, name: 'demo' }], '/api/projects/1/tree': [], '/api/projects/1/checkpoints': [], '/api/models': { models: [], defaults: {} }, '/api/skills': [], '/api/sessions': [], '/api/terminal/status': { enabled: false } } });
const open = async () => { await userEvent.click(await screen.findByRole('button', { name: 'Layout' })); return screen.findByRole('menu', { name: 'Layout' }); };
const shown = (n) => !screen.getByTestId(`pane-${n}`).hasAttribute('data-hidden');
beforeEach(() => localStorage.clear());

describe('Layout menu in the header', () => {
  it('is a labeled button in the header of the workspace page, easy to see', async () => {
    header('/'); const b = await screen.findByRole('button', { name: 'Layout' });
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Layout' })).toBe(b); expect(b).toHaveAttribute('aria-haspopup', 'menu');
  });
  it('appears only where it applies: the workspace, for people who can use it', async () => {
    header('/chat'); await screen.findByText('page'); expect(screen.queryByRole('button', { name: 'Layout' })).toBeNull();
  });
  it('not on Help or Profile', async () => { header('/help'); await screen.findByText('page'); expect(screen.queryByRole('button', { name: 'Layout' })).toBeNull(); });
  it('not for a role that cannot open the workspace', async () => { header('/', userWith(['chat.use'])); await screen.findByText('page'); expect(screen.queryByRole('button', { name: 'Layout' })).toBeNull(); });
  it('is not in the editor any more', async () => {
    workspace(); const bar = await screen.findByRole('navigation', { name: 'Editor menu' }); expect(within(bar).queryByRole('button', { name: 'Layout' })).toBeNull();
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Layout' })).toBeInTheDocument();
  });
  it('lists arrangements, panel toggles with check marks, reset, and a tip', async () => {
    header('/'); const menu = await open();
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual([...Object.values(PRESETS).map((p) => p.label), 'Reset layout']);
    const boxes = within(menu).getAllByRole('menuitemcheckbox'); expect(boxes.map((b) => b.textContent)).toEqual(['Explorer', 'Sessions', 'Terminal', 'Agent', 'Platform status', 'Contact']); for (const b of boxes) expect(b).toHaveAttribute('aria-checked', ['Platform status', 'Contact'].includes(b.textContent) ? 'false' : 'true');
    expect(within(menu).getByText('Arrangements')).toBeInTheDocument(); expect(within(menu).getByText('Panels')).toBeInTheDocument(); expect(within(menu).getByText(/drag a panel by its header/i)).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitemcheckbox', { name: 'Editor' })).toBeNull(); // the editor always stays
  });
  it('opens with the keyboard and closes with Escape', async () => {
    header('/'); const b = await screen.findByRole('button', { name: 'Layout' }); b.focus(); await userEvent.keyboard('{Enter}'); expect(await screen.findByRole('menu', { name: 'Layout' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}'); await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });
});

describe('Layout menu actions change the workspace', () => {
  it('an arrangement rearranges the panels at once, and the choice is remembered', async () => {
    workspace(); await screen.findByTestId('pane-chat'); const chatX = () => parseFloat(screen.getByTestId('pane-chat').style.left);
    const before = layoutStore.get(); expect(visiblePanes(before)).toEqual(visiblePanes(DEFAULT_LAYOUT));
    await userEvent.click(await within(await open()).findByRole('menuitem', { name: PRESETS.chatLeft.label }));
    expect(layoutStore.get()).toEqual(applyPreset(before, 'chatLeft')); expect(layoutStore.get().root.c[0].n.p).toBe('chat'); expect(chatX()).toBe(0);
    await waitFor(() => expect(JSON.parse(localStorage.getItem('ide-layout-v2')).root.c[0].n.p).toBe('chat')); await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });
  it('panels can be hidden and shown again, one after another, without closing the menu', async () => {
    workspace(); await screen.findByTestId('pane-chat'); const menu = await open();
    await userEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Terminal' })); await userEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Sessions' }));
    expect(shown('terminal')).toBe(false); expect(shown('sessions')).toBe(false); expect(shown('chat')).toBe(true);
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'Terminal' })).toHaveAttribute('aria-checked', 'false'); expect(screen.getByRole('menu', { name: 'Layout' })).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Terminal' })); expect(shown('terminal')).toBe(true); expect(within(menu).getByRole('menuitemcheckbox', { name: 'Terminal' })).toHaveAttribute('aria-checked', 'true');
  });
  it('the editor stays while every other panel is hidden', async () => {
    workspace(); await screen.findByTestId('pane-chat'); const menu = await open();
    for (const n of ['Explorer', 'Sessions', 'Terminal', 'Agent']) await userEvent.click(within(menu).getByRole('menuitemcheckbox', { name: n }));
    expect(visiblePanes(layoutStore.get())).toEqual(['editor']); expect(shown('editor')).toBe(true);
  });
  it('Reset layout restores the default', async () => {
    workspace(); await screen.findByTestId('pane-chat');
    await userEvent.click(await within(await open()).findByRole('menuitem', { name: PRESETS.focus.label })); expect(visiblePanes(layoutStore.get())).toEqual(['editor']);
    await userEvent.click(await within(await open()).findByRole('menuitem', { name: 'Reset layout' })); expect(layoutStore.get()).toEqual(DEFAULT_LAYOUT); expect(shown('chat')).toBe(true);
  });
  it('the menu reflects changes made by dragging panels, since both share one layout', async () => {
    workspace(); await screen.findByTestId('pane-chat');
    await userEvent.click(screen.getByRole('button', { name: 'Terminal panel options' })); await userEvent.click(await screen.findByRole('menuitem', { name: 'Hide panel' })); await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    const menu = await open(); expect(within(menu).getByRole('menuitemcheckbox', { name: 'Terminal' })).toHaveAttribute('aria-checked', 'false');
  });
  it('shows the saved layout on the next visit', async () => {
    localStorage.setItem('ide-layout-v2', JSON.stringify(applyPreset(DEFAULT_LAYOUT, 'focus'))); workspace(); await screen.findByTestId('pane-chat');
    expect(shown('chat')).toBe(false); const menu = await open(); expect(within(menu).getByRole('menuitemcheckbox', { name: 'Agent' })).toHaveAttribute('aria-checked', 'false');
  });
});
