import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentPanel from '../src/components/AgentPanel.jsx';
import { renderApp, userWith, ALL } from './helpers.jsx';

const MODELS = { '/api/models': { models: [{ id: 1, label: 'Fake', provider: 'p' }], defaults: {} }, '/api/skills': [] };
// Streams a question and holds the turn open until the client answers.
async function ask(q) {
  let answered; const gate = new Promise((r) => { answered = r; }); const bodies = [];
  renderApp(<AgentPanel project={{ id: 7 }} />, { user: userWith(ALL), routes: { ...MODELS, 'POST /api/agent/respond': (c) => { bodies.push(typeof c.body === 'string' ? JSON.parse(c.body) : c.body); answered(); return { ok: true }; }, 'POST /api/agent/turn': () => new Response(new ReadableStream({ async start(c) {
    const enc = new TextEncoder(), s = (e) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); s({ type: 'start', conversationId: 1 }); s({ type: 'question', id: 'q1', ...q }); await gate; s({ type: 'done' }); c.close();
  } }), { headers: { 'content-type': 'text/event-stream' } }) } });
  await userEvent.type(await screen.findByLabelText('Message'), 'go'); await userEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText(q.question);
  return bodies;
}

describe('ask_user questions', () => {
  it('open-ended: a text box and Answer', async () => {
    const bodies = await ask({ question: 'Which port?' });
    expect(screen.queryByRole('radio')).toBeNull();
    await userEvent.type(screen.getByLabelText('Your answer'), '8080'); await userEvent.click(screen.getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(bodies).toEqual([{ id: 'q1', value: '8080' }]));
  });
  it('multiple choice: picking a choice answers at once', async () => {
    const bodies = await ask({ question: 'Which db?', options: ['SQLite', 'Postgres'] });
    await userEvent.click(screen.getByRole('radio', { name: 'Postgres' }));
    await waitFor(() => expect(bodies).toEqual([{ id: 'q1', value: 'Postgres' }]));
  });
  it('multiple choice always offers Other, which takes a typed answer', async () => {
    const bodies = await ask({ question: 'Which db?', options: ['SQLite', 'Postgres'] });
    expect(screen.queryByLabelText('Your own answer')).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: 'Other…' }));
    const send = screen.getByRole('button', { name: 'Answer' }); expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Your own answer'), 'DuckDB'); await userEvent.click(send);
    await waitFor(() => expect(bodies).toEqual([{ id: 'q1', value: 'DuckDB' }]));
  });
  it('multi-select combines choices with a typed Other', async () => {
    const bodies = await ask({ question: 'Which?', options: ['A', 'B', 'C'], multiple: true });
    await userEvent.click(screen.getByRole('checkbox', { name: 'A' })); await userEvent.click(screen.getByRole('checkbox', { name: 'C' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Other…' })); await userEvent.type(screen.getByLabelText('Your own answer'), 'D');
    await userEvent.click(screen.getByRole('button', { name: 'Send choices' }));
    await waitFor(() => expect(bodies).toEqual([{ id: 'q1', value: 'A, C, D' }]));
  });
});
