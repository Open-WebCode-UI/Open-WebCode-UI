import { describe, it, expect } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentPanel from '../src/components/AgentPanel.jsx';
import Profile from '../src/pages/Profile.jsx';
import { sessions } from '../src/sessionStore.js';
import { renderApp, userWith, ALL } from './helpers.jsx';

const sse = (...evs) => new Response(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const MODELS = { '/api/models': { models: [{ id: 1, label: 'Fake', provider: 'p' }], defaults: {} } };
const SKILLS = [{ id: null, key: 'code-review', name: 'code-review', builtin: true, modified: false, enabled: true, description: 'Review code', instructions: '# Code review', defaults: { description: 'Review code', instructions: '# Code review' } }];
const panel = (turns, extra = {}) => {
  const queue = turns.map((t) => (typeof t === 'function' ? t : () => t)); // a Response body can only be read once, so prefer factories
  return renderApp(<AgentPanel project={{ id: 7 }} />, { user: userWith(ALL), routes: { ...MODELS, '/api/skills': SKILLS, 'POST /api/agent/turn': () => (queue.shift() ?? (() => sse({ type: 'done' })))(), ...extra } });
};
const turnsOf = (fetch) => fetch.calls.filter((c) => c.url === '/api/agent/turn').map((c) => c.body);
const type = async (text) => userEvent.type(await screen.findByLabelText('Message'), text);
const send = () => userEvent.click(screen.getByRole('button', { name: 'Send' }));

describe('each step is its own message', () => {
  const steps = () => sse({ type: 'start', conversationId: 1 }, { type: 'text', text: 'Let me look around.' },
    { type: 'tool_start', id: 'a', name: 'list_dir', args: { path: 'src' } }, { type: 'tool_result', id: 'a', name: 'list_dir', result: 'index.js\napp.js' },
    { type: 'tool_start', id: 'b', name: 'read_file', args: { path: 'src/app.js' } }, { type: 'tool_result', id: 'b', name: 'read_file', result: '1\tconsole.log(1)' },
    { type: 'tool_start', id: 'c', name: 'edit_file', args: { path: 'src/app.js', old_string: 'console.log(1)', new_string: 'console.log(2)' } }, { type: 'tool_result', id: 'c', name: 'edit_file', result: 'Edited src/app.js' },
    { type: 'tool_start', id: 'd', name: 'read_file', args: { path: 'missing.js' } }, { type: 'tool_result', id: 'd', name: 'read_file', result: 'Error: no such file or directory' },
    { type: 'text', text: 'Done with edits.' }, { type: 'done' });

  it('renders a separate card per tool call, in order, with plain-language titles and status', async () => {
    panel([steps]);
    await type('go'); await send();
    const cards = await screen.findAllByTestId('tool-card');
    expect(cards.map((c) => c.dataset.tool)).toEqual(['list_dir', 'read_file', 'edit_file', 'read_file']);
    expect(cards.map((c) => c.dataset.status)).toEqual(['ok', 'ok', 'ok', 'error']);
    expect(within(cards[0]).getByRole('button', { name: 'Listed src' })).toBeInTheDocument();
    expect(within(cards[1]).getByRole('button', { name: 'Read src/app.js' })).toBeInTheDocument();
    expect(within(cards[2]).getByRole('button', { name: 'Edited src/app.js' })).toBeInTheDocument();
  });
  it('text before and after the tool calls appears as separate agent messages around the cards', async () => {
    const { container } = panel([steps]);
    await type('go'); await send();
    await screen.findByText('Done with edits.');
    const order = [...container.querySelectorAll('[data-testid="tool-card"], .markdown-body')].map((n) => (n.dataset.testid === 'tool-card' ? 'tool' : n.textContent.trim()));
    expect(order).toEqual(['Let me look around.', 'tool', 'tool', 'tool', 'tool', 'Done with edits.']);
  });
  it('expands to show details: a diff for edits, results for reads; failures open themselves', async () => {
    panel([steps]);
    await type('go'); await send();
    const cards = await screen.findAllByTestId('tool-card');
    expect(within(cards[2]).queryByText(/console\.log\(2\)/)).toBeNull(); // collapsed by default
    await userEvent.click(within(cards[2]).getByRole('button'));
    expect(within(cards[2]).getByText('- console.log(1)')).toBeInTheDocument(); expect(within(cards[2]).getByText('+ console.log(2)')).toBeInTheDocument();
    await userEvent.click(within(cards[1]).getByRole('button'));
    expect(within(cards[1]).getByText(/1\s+console\.log\(1\)/)).toBeInTheDocument();
    expect(within(cards[3]).getByText('Error: no such file or directory')).toBeVisible(); // auto-opened
  });
  it('shows a running state until the result arrives', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const enc = new TextEncoder();
    const body = new ReadableStream({ async start(c) {
      const s = (e) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      s({ type: 'start', conversationId: 1 }); s({ type: 'tool_start', id: 'x', name: 'run_command', args: { command: 'npm test' } }); await gate;
      s({ type: 'tool_result', id: 'x', name: 'run_command', result: 'exit=0\nall passed' }); s({ type: 'done' }); c.close();
    } });
    panel([new Response(body, { headers: { 'content-type': 'text/event-stream' } })]);
    await type('run tests'); await send();
    const card = await screen.findByTestId('tool-card');
    expect(card.dataset.status).toBe('running'); expect(within(card).getByRole('button', { name: 'Running npm test' })).toBeInTheDocument();
    release();
    await waitFor(() => expect(card.dataset.status).toBe('ok'));
    await userEvent.click(within(card).getByRole('button'));
    expect(within(card).getByText(/\$ npm test/)).toBeInTheDocument(); expect(within(card).getByText(/all passed/)).toBeInTheDocument();
  });
  it('does not show generic cards for the special tools (conclude / switch_mode / propose_plan)', async () => {
    panel([sse({ type: 'start', conversationId: 1 }, { type: 'tool_start', id: 'z', name: 'conclude', args: {} }, { type: 'tool_result', id: 'z', name: 'conclude', result: 'Turn concluded.' }, { type: 'done' })]);
    await type('x'); await send(); await screen.findByText('x');
    await waitFor(() => expect(screen.queryAllByTestId('tool-card')).toHaveLength(0));
  });
});

describe('conclusion card', () => {
  it('renders the conclusion differently from normal replies: status, Markdown summary, files, verification, next steps', async () => {
    panel([sse({ type: 'start', conversationId: 1 }, { type: 'text', text: 'Working…' },
      { type: 'conclusion', summary: 'I added the **login** route.', status: 'partial', changes: ['src/login.js', 'test/login.test.js'], verification: 'Ran the tests: 12 passed', next_steps: ['Add rate limiting', 'Update docs'] }, { type: 'done' })]);
    await type('build login'); await send();
    const card = await screen.findByTestId('conclusion');
    expect(card.dataset.status).toBe('partial');
    expect(within(card).getByText('Partly done')).toBeInTheDocument();
    expect(within(card).getByText('login').tagName).toBe('STRONG');
    expect(within(card).getByText('src/login.js')).toBeInTheDocument(); expect(within(card).getByText('Ran the tests: 12 passed')).toBeInTheDocument();
    expect(within(within(card).getByTestId('conclusion-next')).getAllByRole('button').map((l) => l.textContent)).toEqual(['Add rate limiting', 'Update docs']);
    expect(screen.getByText('Working…').closest('[data-testid="conclusion"]')).toBeNull(); // ordinary text is not in the card
  });
  it.each([['complete', 'All done'], ['blocked', 'Blocked']])('status %s is labeled', async (status, label) => {
    panel([sse({ type: 'start', conversationId: 1 }, { type: 'conclusion', summary: 's', status, changes: [], verification: '', next_steps: [] }, { type: 'done' })]);
    await type('x'); await send();
    expect(within(await screen.findByTestId('conclusion')).getByText(label)).toBeInTheDocument();
  });
});

describe('conclusion card details', () => {
  it('shows what the agent needs, opens files, and turns next steps into your message', async () => {
    const files = Array.from({ length: 10 }, (_, i) => `src/f${i}.js`);
    panel([sse({ type: 'start', conversationId: 1 }, { type: 'conclusion', summary: 'Stopped.', status: 'blocked', changes: files, verification: '', next_steps: ['Add tests'], needs: 'Which database should I use?' }, { type: 'done' })]);
    await type('go'); await send();
    const card = await screen.findByTestId('conclusion');
    expect(within(within(card).getByTestId('conclusion-needs')).getByText('Which database should I use?')).toBeInTheDocument();
    expect(within(card).getAllByRole('button', { name: /^Open src\// })).toHaveLength(8);
    await userEvent.click(within(card).getByRole('button', { name: 'Show 2 more' }));
    expect(within(card).getAllByRole('button', { name: /^Open src\// })).toHaveLength(10);
    const opened = []; const off = sessions.on('open_file', (p) => opened.push(p));
    await userEvent.click(within(card).getByRole('button', { name: 'Open src/f3.js' })); off?.();
    expect(opened).toEqual(['src/f3.js']);
    await userEvent.click(within(card).getByRole('button', { name: /Use as your next message: Add tests/ }));
    expect(screen.getByLabelText('Message')).toHaveValue('Add tests');
  });
});

describe('mode recommendations', () => {
  const request = () => sse({ type: 'start', conversationId: 1 }, { type: 'text', text: 'This is a tiny change.' }, { type: 'mode_request', to: 'act', reason: 'Fixing one typo in README.md' }, { type: 'done' });
  it('shows the agent\'s recommendation and only switches (and starts work) after the user confirms', async () => {
    const { fetch } = panel([request, sse({ type: 'start', conversationId: 1 }, { type: 'done' })]);
    await type('fix the typo'); await send();
    const card = await screen.findByTestId('mode-request');
    expect(within(card).getByText(/recommends switching to Act mode/)).toBeInTheDocument(); expect(within(card).getByText('Fixing one typo in README.md')).toBeInTheDocument();
    expect(turnsOf(fetch)).toHaveLength(1); expect(turnsOf(fetch)[0].mode).toBe('plan'); // nothing happens until confirmed
    expect(screen.getByRole('button', { name: 'Plan mode' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(card).getByRole('button', { name: /Switch to Act/ }));
    await waitFor(() => expect(turnsOf(fetch)).toHaveLength(2));
    expect(turnsOf(fetch)[1]).toMatchObject({ mode: 'act', message: expect.stringMatching(/Go ahead/) });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Act mode' })).toHaveAttribute('aria-pressed', 'true'));
    expect(within(card).getByText('Switched to Act mode')).toBeInTheDocument();
  });
  it('can be declined, staying in Plan mode', async () => {
    const { fetch } = panel([request]);
    await type('fix'); await send();
    await userEvent.click(within(await screen.findByTestId('mode-request')).getByRole('button', { name: 'Not now' }));
    expect(screen.getByText('Declined')).toBeInTheDocument(); expect(turnsOf(fetch)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Plan mode' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('when the agent reverts to Plan mode the toggle follows and the reason is shown', async () => {
    const { fetch } = panel([sse({ type: 'start', conversationId: 1 }, { type: 'mode_changed', to: 'plan', reason: 'This would delete the database' }, { type: 'done' })]);
    await userEvent.click(await screen.findByRole('button', { name: 'Act mode' }));
    await type('go'); await send();
    const note = await screen.findByTestId('mode-changed');
    expect(within(note).getByText('This would delete the database')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plan mode' })).toHaveAttribute('aria-pressed', 'true');
    expect(turnsOf(fetch)[0].mode).toBe('act');
  });
});

describe('toggling the mode acts on what is in the message box', () => {
  const plan = () => sse({ type: 'start', conversationId: 1 }, { type: 'plan', plan: '1. Add the route' }, { type: 'done' });
  const modeBtn = (n) => screen.getByRole('button', { name: `${n} mode` });
  it('typed text is sent immediately in the new mode', async () => {
    const { fetch } = panel([]);
    await type('Add a health check endpoint');
    await userEvent.click(await screen.findByRole('button', { name: 'Act mode' }));
    await waitFor(() => expect(turnsOf(fetch)).toHaveLength(1));
    expect(turnsOf(fetch)[0]).toMatchObject({ mode: 'act', message: 'Add a health check endpoint' });
    expect(screen.getByLabelText('Message')).toHaveValue('');
  });
  it('works toward Plan too (typed text is sent in Plan mode right away)', async () => {
    const { fetch } = panel([sse({ type: 'done' }), sse({ type: 'done' })]);
    await userEvent.click(await screen.findByRole('button', { name: 'Act mode' }));
    await type('Just explain the design'); await userEvent.click(modeBtn('Plan'));
    await waitFor(() => expect(turnsOf(fetch)).toHaveLength(1));
    expect(turnsOf(fetch)[0]).toMatchObject({ mode: 'plan', message: 'Just explain the design' });
  });
  it('with a proposed plan and an empty box, switching to Act starts the plan with no acknowledgment message', async () => {
    const { fetch } = panel([plan, sse({ type: 'start', conversationId: 1 }, { type: 'done' })]);
    await type('plan a route'); await send();
    await screen.findByTestId('plan-card');
    await userEvent.click(modeBtn('Act'));
    await waitFor(() => expect(turnsOf(fetch)).toHaveLength(2));
    expect(turnsOf(fetch)[1]).toMatchObject({ mode: 'act', approvedPlan: '1. Add the route', message: expect.stringMatching(/plan is approved/i) });
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });
  it('typed text takes precedence over the default message but still carries the approved plan', async () => {
    const { fetch } = panel([plan, sse({ type: 'done' })]);
    await type('plan'); await send(); await screen.findByTestId('plan-card');
    await type('Start with the tests please');
    await userEvent.click(modeBtn('Act'));
    await waitFor(() => expect(turnsOf(fetch)).toHaveLength(2));
    expect(turnsOf(fetch)[1]).toMatchObject({ mode: 'act', message: 'Start with the tests please', approvedPlan: '1. Add the route' });
  });
  it('with nothing typed and no plan, toggling just changes the mode (no request)', async () => {
    const { fetch } = panel([]);
    await userEvent.click(await screen.findByRole('button', { name: 'Act mode' }));
    expect(modeBtn('Act')).toHaveAttribute('aria-pressed', 'true'); expect(turnsOf(fetch)).toHaveLength(0);
  });
  it('the "Approve & switch to Act" button starts the plan too', async () => {
    const { fetch } = panel([plan, sse({ type: 'done' })]);
    await type('plan'); await send();
    await userEvent.click(await screen.findByRole('button', { name: /approve & switch to act/i }));
    await waitFor(() => expect(turnsOf(fetch)).toHaveLength(2));
    expect(turnsOf(fetch)[1]).toMatchObject({ mode: 'act', approvedPlan: '1. Add the route' });
  });
  it('cannot be toggled to Act without agent.act', async () => {
    renderApp(<AgentPanel project={{ id: 7 }} />, { user: userWith(['agent.plan', 'provider.use']), routes: { ...MODELS, '/api/skills': [] } });
    expect(await screen.findByRole('button', { name: 'Act mode' })).toBeDisabled();
  });
});

describe('skills in the message box', () => {
  it('the Skills menu inserts /skill-name, which is sent as typed', async () => {
    const { fetch } = panel([sse({ type: 'done' })]);
    await userEvent.click(await screen.findByRole('button', { name: 'Skills' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /code-review/ }));
    expect(screen.getByLabelText('Message')).toHaveValue('/code-review ');
    await userEvent.type(screen.getByLabelText('Message'), 'src/app.js'); await send();
    await waitFor(() => expect(turnsOf(fetch)[0].message).toBe('/code-review src/app.js'));
  });
  it('shows a "Skill: name" step when the agent uses one', async () => {
    panel([sse({ type: 'start', conversationId: 1 }, { type: 'skill', name: 'security-review' }, { type: 'done' })]);
    await type('/security-review'); await send();
    expect(await screen.findByText('Skill: security-review')).toBeInTheDocument();
  });
});

describe('profile: managing skills', () => {
  const prompts = { defaults: { plan: 'p', act: 'a', chat: 'c' }, overrides: { plan: '', act: '', chat: '' } };
  const skills = [
    { ...SKILLS[0] }, { id: 5, key: null, name: 'api-review', builtin: false, modified: false, enabled: true, description: 'Our REST rules', instructions: 'Check naming.' },
    { id: 9, key: 'debug', name: 'debug', builtin: true, modified: true, enabled: true, description: 'Debug', instructions: 'My debug steps', defaults: { description: 'Debug', instructions: '# Debug' } },
  ];
  const view = (user = userWith(ALL), extra = {}) => renderApp(<Profile />, { route: '/profile/skills', user, routes: { '/api/profile/prompts': prompts, '/api/auth/sessions': [], '/api/skills': skills, ...extra } });

  it('lists pre-written and custom skills with their state', async () => {
    view();
    const rows = await screen.findAllByTestId('skill-row');
    expect(rows.map((r) => within(r).getByText(/^\/[a-z-]+$/).textContent)).toEqual(['/code-review', '/api-review', '/debug']);
    expect(within(rows[0]).getByText('built-in')).toBeInTheDocument(); expect(within(rows[2]).getByText('built-in (modified)')).toBeInTheDocument();
    expect(within(rows[1]).queryByText(/built-in/)).toBeNull();
  });
  it('edits a built-in skill (saved as the user\'s override) and can reset a modified one', async () => {
    const { fetch } = view(userWith(ALL), { 'PUT /api/skills/builtin/code-review': { ok: true }, 'DELETE /api/skills/builtin/debug': { ok: true } });
    const rows = await screen.findAllByTestId('skill-row');
    await userEvent.click(within(rows[0]).getByRole('button', { name: 'Edit' }));
    const box = await screen.findByLabelText('Skill instructions');
    await userEvent.clear(box); await userEvent.type(box, 'Focus on error handling.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'PUT' && c.url.includes('/builtin/code-review')).body).toMatchObject({ instructions: 'Focus on error handling.' }));
    await userEvent.click(within((await screen.findAllByTestId('skill-row'))[2]).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'DELETE' && c.url.includes('/builtin/debug'))).toBe(true));
  });
  it('creates a custom skill, toggles, and deletes it', async () => {
    window.confirm = () => true;
    const { fetch } = view(userWith(ALL), { 'POST /api/skills': { id: 11 }, 'PUT /api/skills/custom/5': { ok: true }, 'DELETE /api/skills/custom/5': { ok: true } });
    await userEvent.click(await screen.findByRole('button', { name: 'New skill' }));
    await userEvent.type(await screen.findByLabelText('Name'), 'perf-review');
    await userEvent.type(screen.getByLabelText(/description/i), 'Find slow code');
    await userEvent.type(screen.getByLabelText('Skill instructions'), 'Look for N+1 queries.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'POST' && c.url === '/api/skills?scope=agent').body).toEqual({ name: 'perf-review', description: 'Find slow code', instructions: 'Look for N+1 queries.', enabled: true }));
    await userEvent.click(await screen.findByLabelText('Enable api-review'));
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'PUT' && c.url.includes('/custom/5')).body).toMatchObject({ enabled: false, name: 'api-review' }));
    await userEvent.click(within((await screen.findAllByTestId('skill-row'))[1]).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'DELETE' && c.url.includes('/custom/5'))).toBe(true));
  });
  it('is read-only without profile.skills.edit', async () => {
    view(userWith(['agent.plan', 'chat.use']));
    const rows = await screen.findAllByTestId('skill-row');
    expect(screen.queryByRole('button', { name: 'New skill' })).toBeNull();
    expect(within(rows[0]).getByRole('button', { name: 'View' })).toBeInTheDocument(); expect(within(rows[0]).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByLabelText('Enable code-review')).toBeDisabled();
  });
});

describe('prompt processing status', () => {
  it('shows the status card while the model reads the prompt and removes it when the answer starts', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    panel([async () => {
      await gate;
      return sse({ type: 'start', conversationId: 1 }, { type: 'phase', phase: 'generating' }, { type: 'text', text: 'Hello' }, { type: 'done' });
    }]);
    await type('go'); await send();
    expect(await screen.findByTestId('turn-status')).toBeInTheDocument();
    release();
    expect(await screen.findByText('Hello')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('turn-status')).not.toBeInTheDocument());
  });
});

describe('stop and resume', () => {
  // A turn that stays open until the client aborts it, like a model that is still generating.
  const open = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const stoppable = (...later) => {
    const queue = [open, ...later];
    return panel([], { 'POST /api/agent/turn': (init) => { const t = queue.shift() ?? (() => sse({ type: 'done' })); return t(init); } });
  };
  it('Stop leaves a Stopped card; Resume sends a resume turn in the same mode and conversation', async () => {
    const { fetch } = stoppable(() => sse({ type: 'start', conversationId: 1 }, { type: 'text', text: 'Carrying on' }, { type: 'done' }));
    await type('go'); await send();
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByTestId('stopped')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByText('Carrying on')).toBeInTheDocument();
    expect(screen.queryByTestId('stopped')).not.toBeInTheDocument();
    const turns = turnsOf(fetch);
    expect(turns[1]).toMatchObject({ resume: true, mode: 'plan', message: expect.stringContaining('interrupted') });
    expect(turns[0].resume).toBeUndefined();
  });
  it('Dismiss removes the card', async () => {
    stoppable();
    await type('go'); await send();
    await userEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('stopped')).not.toBeInTheDocument();
  });
});
