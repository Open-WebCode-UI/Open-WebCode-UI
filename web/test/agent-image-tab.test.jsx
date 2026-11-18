import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, userWith, ALL } from './helpers.jsx';

vi.mock('@monaco-editor/react', () => ({ default: () => <div data-testid="monaco" />, DiffEditor: () => <div /> }));
const { default: IDE } = await import('../src/pages/IDE.jsx');

const sse = (...evs) => new Response(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const routes = (turn) => ({
  '/api/projects': [{ id: 1, name: 'demo' }], '/api/projects/1/tree': [{ name: 'a.js', path: 'a.js', type: 'file' }], '/api/projects/1/checkpoints': [],
  '/api/models': { models: [{ id: 1, label: 'Fake', provider: 'p' }], defaults: {} }, '/api/skills': [], 'POST /api/agent/turn': turn,
});
const GEN = { id: 'g1', name: 'generated-1.png', kind: 'image' };
beforeEach(() => localStorage.clear());

describe('an image the agent produced, opened in the editor', () => {
  it('opens read only in a new tab, and a second open switches to that tab', async () => {
    renderApp(<IDE />, { user: userWith(ALL), routes: routes(() => sse({ type: 'start', conversationId: 1 }, { type: 'media', attachments: [GEN] }, { type: 'done' })) });
    await userEvent.type(await screen.findByLabelText('Message'), 'draw');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await userEvent.click(await screen.findByRole('button', { name: 'Open generated-1.png in a tab' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open generated-1.png in a tab' }));

    expect(screen.getAllByRole('tab', { name: /generated-1\.png/ })).toHaveLength(1);
    const shown = screen.getAllByRole('img', { name: 'generated-1.png' });
    expect(shown).toHaveLength(2); // the agent's copy and the editor tab's copy
    shown.forEach((img) => expect(img).toHaveAttribute('src', '/api/attachments/g1'));
    expect(screen.queryByTestId('monaco')).toBeNull(); // no text editor for an image
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
