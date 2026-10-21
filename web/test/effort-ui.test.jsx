import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, userWith, ALL } from './helpers.jsx';
import AgentPanel from '../src/components/AgentPanel.jsx';

const sse = (...evs) => new Response(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
beforeEach(() => localStorage.clear());
const setup = (model, turn) => renderApp(<AgentPanel project={{ id: 7 }} />, { user: userWith(ALL), routes: { '/api/models': { models: [model], defaults: {} }, '/api/skills': [], 'POST /api/agent/turn': turn } });

describe('effort and thinking controls', () => {
  it('the Thinking switch is always there, disabled with an explanation when the model does not think', async () => {
    setup({ id: 1, label: 'Local', provider: 'p', supportsThinking: false }, () => sse({ type: 'done' }));
    await userEvent.click(await screen.findByRole('button', { name: /^Model:/ })); // settings live in the model dialog
    const sw = await screen.findByRole('switch', { name: 'Thinking' });
    expect(sw).toBeDisabled();
  });
  it('the Thinking switch is usable for a thinking model', async () => {
    setup({ id: 1, label: 'Claude', provider: 'p', supportsThinking: true }, () => sse({ type: 'done' }));
    await userEvent.click(await screen.findByRole('button', { name: /^Model:/ })); // settings live in the model dialog
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Thinking' })).toBeEnabled());
  });
  it('sends the chosen effort with the turn, and remembers it', async () => {
    let body;
    setup({ id: 1, label: 'Local', provider: 'p', supportsThinking: false }, (req) => { body = req; return sse({ type: 'done' }); });
    await userEvent.click(await screen.findByRole('button', { name: /^Model:/ })); // settings live in the model dialog
    await userEvent.click(await screen.findByRole('button', { name: 'Thorough' }));
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(localStorage.getItem('effortLevel')).toBe('thorough');
    await userEvent.type(screen.getByLabelText('Message'), 'do it'); await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(body).toBeTruthy());
    expect(JSON.stringify(body)).toContain('thorough');
  });
});
