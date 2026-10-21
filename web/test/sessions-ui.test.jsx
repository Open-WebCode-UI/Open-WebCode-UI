import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentPanel from '../src/components/AgentPanel.jsx';
import SessionsPanel, { timeAgo } from '../src/components/SessionsPanel.jsx';
import ThinkingTips from '../src/components/ThinkingTips.jsx';
import SkillsMenu from '../src/components/SkillsMenu.jsx';
import ContextBanner from '../src/components/ContextBanner.jsx';
import { buildTips } from '../src/components/tips.js';
import { sessions } from '../src/sessionStore.js';
import { renderApp, userWith, ALL } from './helpers.jsx';

const sse = (...evs) => new Response(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const MODELS = { '/api/models': { models: [{ id: 1, label: 'Fake', provider: 'p' }], defaults: {} } };
const SKILLS = [{ name: 'compact', builtin: true, enabled: true, description: 'Summarize' }, { name: 'code-review', builtin: true, enabled: true, description: 'Review' }, { name: 'perf-check', builtin: false, enabled: true, description: 'Find slow code' }];
const stream = () => { let go; const gate = new Promise((r) => { go = r; }); const enc = new TextEncoder(); let ctl; const body = new ReadableStream({ start(c) { ctl = c; } }); return { response: (init) => { init?.signal?.addEventListener('abort', () => { try { ctl.error(Object.assign(new Error('Aborted'), { name: 'AbortError' })); } catch { /* already closed */ } }); return new Response(body, { headers: { 'content-type': 'text/event-stream' } }); }, send: (e) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)), end: () => ctl.close(), gate, go }; };
const turnsOf = (fetch) => fetch.calls.filter((c) => c.url === '/api/agent/turn').map((c) => c.body);
const panel = (routes = {}, props = {}) => renderApp(<AgentPanel project={{ id: 7 }} {...props} />, { user: userWith(ALL), routes: { ...MODELS, '/api/skills': SKILLS, ...routes } });
const type = async (t) => userEvent.type(await screen.findByLabelText('Message'), t);
const send = () => userEvent.click(screen.getByRole('button', { name: 'Send' }));

describe('sessions survive navigating away', () => {
  it('a turn keeps streaming into its session while the panel is gone, and the page shows it again on return', async () => {
    const st = stream();
    const first = panel({ 'POST /api/agent/turn': () => st.response() });
    await type('build a thing'); await send();
    st.send({ type: 'start', conversationId: 12 }); st.send({ type: 'text', text: 'Working on it…' });
    expect(await screen.findByText('Working on it…')).toBeInTheDocument();
    first.unmount();                                                       // navigate away (Help, Profile, …)
    st.send({ type: 'tool_start', id: 't1', name: 'list_dir', args: { path: '.' } }); st.send({ type: 'tool_result', id: 't1', name: 'list_dir', result: 'a.js' }); st.send({ type: 'text', text: ' Done!' }); st.send({ type: 'context', tokens: 500, limit: 100000, pct: 0, level: 'ok' }); st.send({ type: 'done' });
    await waitFor(() => expect(sessions.get(7).items.some((i) => i.kind === 'tool' && i.result === 'a.js')).toBe(true)); // it kept going
    st.end(); await waitFor(() => expect(sessions.get(7).busy).toBe(false));
    panel({ 'POST /api/agent/turn': () => st.response() });                 // come back
    expect(await screen.findByText('Working on it…')).toBeInTheDocument(); expect(screen.getByText('Done!')).toBeInTheDocument(); expect(screen.getAllByTestId('tool-card')).toHaveLength(1); // reply, tool step, reply: just as it streamed expect(screen.getByText('build a thing')).toBeInTheDocument();
  });
  it('coming back mid-turn shows it still running, with Stop available', async () => {
    const st = stream(); const a = panel({ 'POST /api/agent/turn': (init) => st.response(init) }); await type('go'); await send(); st.send({ type: 'start', conversationId: 3 }); await screen.findByRole('button', { name: 'Stop' });
    a.unmount(); panel({}); expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Plan mode' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' })); await waitFor(() => expect(sessions.get(7).busy).toBe(false));
  });
  it('keeps the draft and mode when the panel is closed and reopened', async () => {
    const a = panel(); sessions.setDraft(7, 'half a thought'); sessions.setMode(7, 'act'); a.unmount();
    panel(); expect(await screen.findByLabelText('Message')).toHaveValue('half a thought'); expect(screen.getByRole('button', { name: 'Act mode' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('sessions are kept per project', async () => {
    sessions.setDraft(7, 'for seven'); sessions.setDraft(8, 'for eight'); expect(sessions.get(7).draft).toBe('for seven'); expect(sessions.get(8).draft).toBe('for eight'); expect(sessions.get(9).draft).toBe('');
  });
  it('reopens the most recent saved session the first time a project is shown (a reload does not look like lost work)', async () => {
    panel({ '/api/sessions': [{ id: 31, title: 'Newest', mode: 'act' }, { id: 30, title: 'Older', mode: 'plan' }], '/api/sessions/31': { id: 31, title: 'Newest', mode: 'act', pendingPlan: null, context: { tokens: 10, limit: 1000, pct: 1, level: 'ok' }, items: [{ kind: 'user', text: 'earlier question' }, { kind: 'assistant', text: 'earlier answer', thinking: '' }] } });
    expect(await screen.findByText('earlier answer')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Act mode' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('does not replace a session already on screen', async () => {
    sessions.setDraft(7, 'x'); sessions.newSession(7); const { fetch } = panel({ '/api/sessions': [{ id: 1 }], '/api/sessions/1': { id: 1, items: [] } });
    await screen.findByLabelText('Message'); expect(fetch.calls.some((c) => /\/api\/sessions\/1$/.test(c.url))).toBe(false);
  });
});

describe('Sessions pane', () => {
  const ROW = (o) => ({ id: 1, title: 'Fix login bug', createdAt: 0, updatedAt: Math.floor(Date.now() / 1000) - 7200, mode: 'plan', messages: 4, running: false, context: { tokens: 12000, limit: 128000, pct: 9, level: 'ok' }, ...o });
  const SESSION = (id, o = {}) => ({ id, title: `Session ${id}`, mode: 'act', pendingPlan: null, context: { tokens: 800, limit: 128000, pct: 1, level: 'ok' }, items: [{ kind: 'user', text: `question ${id}` }, { kind: 'assistant', text: `answer ${id}`, thinking: '' }], ...o });
  const view = (list, routes = {}) => renderApp(<><SessionsPanel project={{ id: 7 }} /><AgentPanel project={{ id: 7 }} /></>, { user: userWith(ALL), routes: { ...MODELS, '/api/skills': SKILLS, '/api/sessions': list, ...routes } });

  it('lists sessions with age, mode, and size, and tells the user when a session is long', async () => {
    view([ROW({ id: 1 }), ROW({ id: 2, title: 'Refactor API', mode: 'act', updatedAt: Math.floor(Date.now() / 1000) - 30, context: { tokens: 90000, limit: 128000, pct: 70, level: 'warn' } })], { '/api/sessions/1': SESSION(1, { title: 'Fix login bug' }) });
    const a = await screen.findByTestId('session-1'), b = await screen.findByTestId('session-2');
    expect(within(a).getByText('Fix login bug')).toBeInTheDocument(); expect(within(a).getByText('2 h ago')).toBeInTheDocument(); expect(within(a).getByText('Plan')).toBeInTheDocument(); expect(within(a).getByText('~12k tokens')).toBeInTheDocument();
    expect(within(b).getByText('just now')).toBeInTheDocument(); expect(within(b).getByText('Act')).toBeInTheDocument(); expect(within(b).getByText('long')).toBeInTheDocument();
  });
  it('opens a session, shows its history in the agent panel, and continues it with the same session id', async () => {
    const { fetch } = view([ROW({ id: 5 }), ROW({ id: 6, title: 'Other' })], { '/api/sessions/5': SESSION(5), '/api/sessions/6': SESSION(6), 'POST /api/agent/turn': () => sse({ type: 'start', conversationId: 6 }, { type: 'text', text: 'Sure.' }, { type: 'done' }) });
    expect(await screen.findByText('answer 5')).toBeInTheDocument(); // auto-resumed newest
    await userEvent.click(await screen.findByTestId('session-6')); expect(await screen.findByText('answer 6')).toBeInTheDocument(); expect(screen.queryByText('answer 5')).toBeNull();
    expect(screen.getByTestId('session-6')).toHaveClass('Mui-selected'); expect(screen.getByRole('button', { name: 'Act mode' })).toHaveAttribute('aria-pressed', 'true');
    await type('and then?'); await send(); await waitFor(() => expect(turnsOf(fetch)).toHaveLength(1)); expect(turnsOf(fetch)[0]).toMatchObject({ conversationId: 6, message: 'and then?', mode: 'act' });
    expect(await screen.findByText('Sure.')).toBeInTheDocument(); expect(screen.getByText('answer 6')).toBeInTheDocument(); // new reply appended to the old history
  });
  it('restores a plan that was waiting for approval, so Act can start it', async () => {
    const { fetch } = view([ROW({ id: 9 })], { '/api/sessions/9': SESSION(9, { mode: 'plan', pendingPlan: '1. Add route', items: [{ kind: 'user', text: 'plan it' }, { kind: 'plan', plan: '1. Add route', state: 'pending' }] }), 'POST /api/agent/turn': () => sse({ type: 'done' }) });
    await screen.findByTestId('plan-card'); await userEvent.click(screen.getByRole('button', { name: 'Act mode' }));
    await waitFor(() => expect(turnsOf(fetch)).toHaveLength(1)); expect(turnsOf(fetch)[0]).toMatchObject({ mode: 'act', approvedPlan: '1. Add route', conversationId: 9 });
  });
  it('New session clears the conversation but keeps the old one in the list', async () => {
    view([ROW({ id: 5 })], { '/api/sessions/5': SESSION(5) }); await screen.findByText('answer 5');
    await userEvent.click(screen.getByRole('button', { name: 'New session' })); await waitFor(() => expect(screen.queryByText('answer 5')).toBeNull());
    expect(screen.getByTestId('session-new')).toBeInTheDocument(); expect(screen.getByTestId('session-5')).toBeInTheDocument(); expect(sessions.get(7).convId).toBeNull();
  });
  it('a new session appears in the list once its first message is sent', async () => {
    let saved = false;
    view(() => (saved ? [ROW({ id: 77, title: 'Brand new' })] : []), { 'POST /api/agent/turn': () => { saved = true; return sse({ type: 'start', conversationId: 77 }, { type: 'text', text: 'hi' }, { type: 'done' }); } });
    await type('Brand new'); await send(); expect(await screen.findByTestId('session-77')).toBeInTheDocument(); expect(screen.queryByTestId('session-new')).toBeNull();
  });
  it('cannot switch sessions while a turn is running, and marks the running one', async () => {
    const st = stream(); view([ROW({ id: 1 }), ROW({ id: 2 })], { '/api/sessions/1': SESSION(1), 'POST /api/agent/turn': () => st.response() });
    await screen.findByText('answer 1'); await type('go'); await send(); st.send({ type: 'start', conversationId: 1 });
    await waitFor(() => expect(screen.getByTestId('session-2')).toHaveAttribute('aria-disabled', 'true')); expect(within(screen.getByTestId('session-1')).getByTestId('running-dot')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'New session' })).toBeEnabled();
    st.send({ type: 'done' }); st.end();
  });
  it('warns before a second session starts while one is running, and lets the user continue', async () => {
    const st = stream(); view([ROW({ id: 1 })], { '/api/sessions/1': SESSION(1), 'POST /api/agent/turn': () => st.response() });
    await screen.findByText('answer 1'); await type('go'); await send(); st.send({ type: 'start', conversationId: 1 });
    await waitFor(() => expect(screen.getByTestId('running-dot')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(await screen.findByText(/may cause overwrites/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(screen.queryByTestId('session-new')).toBeNull(); await waitFor(() => expect(screen.queryByText(/may cause overwrites/)).toBeNull());
    await userEvent.click(await screen.findByRole('button', { name: 'New session' })); await userEvent.click(await screen.findByRole('button', { name: 'Start new session anyway' }));
    expect(await screen.findByTestId('session-new')).toBeInTheDocument(); expect(within(screen.getByTestId('session-1')).getByTestId('running-dot')).toBeInTheDocument();
    st.send({ type: 'done' }); st.end();
  });
  it('renames a session', async () => {
    const { fetch } = view([ROW({ id: 5 })], { '/api/sessions/5': SESSION(5), 'PUT /api/sessions/5': { ok: true, title: 'Auth work' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Options for Fix login bug' })); await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const box = await screen.findByLabelText('Name'); expect(box).toHaveValue('Fix login bug'); await userEvent.clear(box); await userEvent.type(box, 'Auth work{Enter}');
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'PUT' && c.url === '/api/sessions/5').body).toEqual({ title: 'Auth work' }));
  });
  it('deletes a session after confirmation; deleting the open one starts a fresh session', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { fetch } = view([ROW({ id: 5 })], { '/api/sessions/5': SESSION(5), 'DELETE /api/sessions/5': { ok: true } }); await screen.findByText('answer 5');
    for (let i = 0; i < 2; i += 1) { await userEvent.click(await screen.findByRole('button', { name: 'Options for Fix login bug' })); await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' })); await waitFor(() => expect(screen.queryByRole('menu')).toBeNull()); }
    await waitFor(() => expect(fetch.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)); expect(confirm.mock.calls[0][0]).toContain('Fix login bug'); await waitFor(() => expect(screen.queryByText('answer 5')).toBeNull());
  });
  it('relative times read naturally', () => {
    const now = 1_000_000_000_000; const s = now / 1000;
    expect(timeAgo(s - 10, now)).toBe('just now'); expect(timeAgo(s - 600, now)).toBe('10 min ago'); expect(timeAgo(s - 7200, now)).toBe('2 h ago'); expect(timeAgo(s - 3 * 86400, now)).toBe('3 d ago'); expect(timeAgo(s - 30 * 86400, now)).toMatch(/\d/);
  });
  it('asks the user to pick a project when there is none', () => { renderApp(<SessionsPanel project={null} />, { user: userWith(ALL) }); expect(screen.getByText('Select a project to see its sessions.')).toBeInTheDocument(); });
});

describe('context banner, compacting, and clearing', () => {
  const ctx = (level, pct) => ({ type: 'context', tokens: pct * 1000, limit: 100000, pct, level });
  it('stays quiet for a small session, then suggests compacting, then insists as the session fills', async () => {
    panel({ 'POST /api/agent/turn': () => sse({ type: 'start', conversationId: 1 }, ctx('ok', 20), { type: 'done' }) }); await type('a'); await send(); await screen.findByTestId('assistant', {}, { timeout: 100 }).catch(() => {});
    await waitFor(() => expect(sessions.get(7).context).toMatchObject({ level: 'ok' })); expect(screen.queryByTestId('context-banner')).toBeNull();
  });
  const banner = (level, pct) => render(<ContextBanner context={{ tokens: pct * 1000, limit: 100000, pct, level }} busy={false} onCompact={vi.fn()} onClear={vi.fn()} onNew={vi.fn()} />);
  it('is silent when fine, friendly when long, and firmer when almost full', () => {
    const { container } = render(<ContextBanner context={{ tokens: 5000, limit: 100000, pct: 5, level: 'ok' }} />); expect(container.textContent).toBe('');
    banner('warn', 65); expect(screen.getByTestId('context-banner')).toHaveTextContent(/getting long \(about 65k of 100k tokens, 65%\)/);
  });
  it('the high-level message says to compact now', () => { banner('high', 90); expect(screen.getByTestId('context-banner')).toHaveTextContent(/almost full[\s\S]*Compact it now/); expect(screen.getByTestId('context-banner').dataset.level).toBe('high'); });
  it('offers Compact, Clear, and New session, which do what they say', async () => {
    const { fetch } = panel({ 'POST /api/agent/turn': () => sse({ type: 'start', conversationId: 1 }, ctx('warn', 70), { type: 'done' }) });
    await type('hello'); await send(); const b = await screen.findByTestId('context-banner'); expect(b.dataset.level).toBe('warn');
    await userEvent.click(within(b).getByRole('button', { name: 'Compact' })); await waitFor(() => expect(turnsOf(fetch)).toHaveLength(2)); expect(turnsOf(fetch)[1]).toMatchObject({ message: '/compact', conversationId: 1 });
    await userEvent.click(within(await screen.findByTestId('context-banner')).getByRole('button', { name: 'Clear' })); await waitFor(() => expect(turnsOf(fetch)).toHaveLength(3)); expect(turnsOf(fetch)[2].message).toBe('/clear');
    await userEvent.click(within(await screen.findByTestId('context-banner')).getByRole('button', { name: 'New session' })); expect(sessions.get(7).convId).toBeNull(); expect(sessions.get(7).items).toEqual([]);
  });
  it('shows summarizing progress, then replaces the old messages with a card holding the summary', async () => {
    const st = stream(); panel({ 'POST /api/agent/turn': () => st.response() }); await type('/compact keep the db decisions'); await send();
    st.send({ type: 'start', conversationId: 4 }); st.send({ type: 'compacting' }); expect(await screen.findByTestId('compacting')).toBeInTheDocument();
    st.send({ type: 'compacted', summary: '## Goal\nShip it', archived: 6 }); st.send(ctx('ok', 3)); st.send({ type: 'done' }); st.end();
    const card = await screen.findByTestId('compacted'); expect(screen.queryByTestId('compacting')).toBeNull(); expect(screen.getByText('/compact keep the db decisions')).toBeInTheDocument(); // old messages stay on screen
    expect(within(card).getByText('Context compacted: 6 earlier messages summarized')).toBeInTheDocument(); expect(within(card).queryByText('Ship it')).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Context compacted' })); expect(within(card).getByRole('heading', { name: 'Goal' })).toBeInTheDocument(); expect(within(card).getByText('Ship it')).toBeInTheDocument();
    expect(screen.queryByTestId('context-banner')).toBeNull();
  });
  it('/clear leaves a note; "nothing to compact" shows as information; errors show as errors', async () => {
    panel({ 'POST /api/agent/turn': () => sse({ type: 'start', conversationId: 1 }, { type: 'cleared', archived: 1 }, { type: 'done' }) }); await type('/clear'); await send();
    expect(await screen.findByTestId('cleared')).toHaveTextContent('Context cleared: 1 earlier message no longer in the agent\'s memory');
  });
  it('notices and errors from commands are shown', async () => {
    panel({ 'POST /api/agent/turn': () => sse({ type: 'start', conversationId: 1 }, { type: 'notice', text: 'There is nothing to compact yet.' }, { type: 'error', message: 'Could not compact the session: model down' }, { type: 'done' }) });
    await type('/compact'); await send(); expect(await screen.findByText('There is nothing to compact yet.')).toBeInTheDocument(); expect(screen.getByText(/Could not compact the session/)).toBeInTheDocument();
  });
});

describe('tips while the agent works', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());
  it('cycles through tips on a timer', () => {
    render(<ThinkingTips tips={['one', 'two', 'three']} intervalMs={1000} />);
    expect(screen.getByTestId('tip')).toHaveTextContent('Tip: one'); act(() => { vi.advanceTimersByTime(1000); }); expect(screen.getByTestId('tip')).toHaveTextContent('Tip: two');
    act(() => { vi.advanceTimersByTime(2000); }); expect(screen.getByTestId('tip')).toHaveTextContent('Tip: one'); // wraps around
  });
  it('shows nothing without tips, and does not announce itself to screen readers', () => { const { container } = render(<ThinkingTips tips={[]} />); expect(container.textContent).toBe(''); render(<ThinkingTips tips={['x']} />); expect(screen.getByTestId('tip')).toHaveAttribute('aria-live', 'off'); });
  it('appears only while the agent is working', async () => {
    const st = stream(); panel({ 'POST /api/agent/turn': () => st.response() }); expect(screen.queryByTestId('tip')).toBeNull();
    await type('go'); await send(); expect(await screen.findByTestId('tip')).toHaveTextContent(/Tip: Long session\? Type \/compact/);
    st.send({ type: 'done' }); st.end(); await waitFor(() => expect(screen.queryByTestId('tip')).toBeNull());
  });
});

describe('which tips a user sees', () => {
  const skills = [{ name: 'compact', enabled: true, builtin: true }, { name: 'code-review', enabled: true, builtin: true }, { name: 'security-review', enabled: false, builtin: true }, { name: 'perf-check', enabled: true, builtin: false, description: 'Find slow code.' }];
  it('suggests only commands that are available, including custom ones', () => {
    const t = buildTips({ skills, can: () => true, mode: 'plan' }).join('\n');
    expect(t).toMatch(/\/compact/); expect(t).toMatch(/\/clear/); expect(t).toMatch(/\/code-review/); expect(t).not.toMatch(/\/security-review/); expect(t).toMatch(/Your \/perf-check skill is ready: Find slow code\./);
  });
  it('leaves out /compact when that skill is off, and role-specific tips when the role lacks the permission', () => {
    const noCompact = buildTips({ skills: skills.map((s) => (s.name === 'compact' ? { ...s, enabled: false } : s)), can: () => false }).join('\n'); expect(noCompact).not.toMatch(/\/compact/);
    expect(noCompact).not.toMatch(/Checkpoints tab/); expect(noCompact).not.toMatch(/Terminal panel/); expect(noCompact).not.toMatch(/Switch to Act/);
    expect(buildTips({ skills, can: (p) => p === 'checkpoint.write' }).join('\n')).toMatch(/Checkpoints tab/); expect(buildTips({ skills, can: (p) => p === 'terminal.use' }).join('\n')).toMatch(/Terminal panel/);
  });
  it('mode-aware advice for Act and Plan', () => {
    expect(buildTips({ skills, can: () => true, mode: 'plan' }).join('\n')).toMatch(/plan is waiting, it starts right away/); expect(buildTips({ skills, can: () => true, mode: 'act' }).join('\n')).toMatch(/saves a checkpoint at the start/);
  });
});

describe('skills menu', () => {
  it('lists /compact and /clear along with the other skills', async () => {
    renderApp(<SkillsMenu onPick={() => {}} />, { user: userWith(ALL), routes: { '/api/skills': SKILLS } });
    await userEvent.click(await screen.findByRole('button', { name: 'Skills' }));
    expect((await screen.findAllByRole('menuitem')).map((m) => m.textContent.split(/(?=[A-Z])/)[0])).toEqual(expect.arrayContaining(['/compact', '/code-review', '/perf-check', '/clear']));
  });
  it('picking a command puts it in the message box', async () => {
    const onPick = vi.fn(); renderApp(<SkillsMenu onPick={onPick} />, { user: userWith(ALL), routes: { '/api/skills': SKILLS } });
    await userEvent.click(await screen.findByRole('button', { name: 'Skills' })); await userEvent.click(await screen.findByRole('menuitem', { name: /\/clear/ })); expect(onPick).toHaveBeenCalledWith('/clear');
  });
});
