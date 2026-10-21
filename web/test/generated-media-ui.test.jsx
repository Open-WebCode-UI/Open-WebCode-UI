import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentPanel from '../src/components/AgentPanel.jsx';
import Chat from '../src/pages/Chat.jsx';
import { renderApp, userWith, ALL } from './helpers.jsx';

const sse = (...evs) => new Response(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const MODELS = { '/api/models': { models: [{ id: 1, label: 'Fake', provider: 'p' }], defaults: {} } };

describe('media a tool returned', () => {
  const run = async (events) => {
    renderApp(<AgentPanel project={{ id: 7 }} />, { user: userWith(ALL), routes: { ...MODELS, 'POST /api/agent/turn': () => sse({ type: 'start', conversationId: 1 }, ...events, { type: 'done' }) } });
    await userEvent.type(await screen.findByLabelText('Message'), 'draw');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const card = await screen.findByTestId('tool-card');
    await userEvent.click(within(card).getAllByRole('button')[0]);
    return card;
  };
  const call = (attachments) => [{ type: 'tool_start', id: 'a', name: 'mcp__d__render', args: {} }, { type: 'tool_result', id: 'a', name: 'mcp__d__render', result: 'a chart\n[image returned: attachment x]', attachments }];

  it('shows an image from the attachment endpoint under the result text', async () => {
    const card = await run(call([{ id: 'ab12', name: 'render-1.png', kind: 'image' }]));
    const img = within(card).getByRole('img', { name: 'render-1.png' });
    expect(img).toHaveAttribute('src', '/api/attachments/ab12');
    expect(within(card).getByText(/a chart/)).toBeInTheDocument();
  });

  it('plays audio and video with controls', async () => {
    const card = await run(call([{ id: 'c1', name: 'clip.wav', kind: 'audio' }, { id: 'v1', name: 'clip.mp4', kind: 'video' }]));
    expect(card.querySelector('audio[controls]')).toHaveAttribute('src', '/api/attachments/c1');
    expect(card.querySelector('video[controls]')).toHaveAttribute('src', '/api/attachments/v1');
  });

  it('every image has a download link that asks the server for an attachment', async () => {
    const card = await run(call([{ id: 'ab12', name: 'render-1.png', kind: 'image' }]));
    const dl = within(card).getByRole('link', { name: 'Download render-1.png' });
    expect(dl).toHaveAttribute('href', '/api/attachments/ab12?download=1'); expect(dl).toHaveAttribute('download', 'render-1.png');
  });

  it('a result without attachments renders as before', async () => {
    const card = await run([{ type: 'tool_start', id: 'a', name: 'mcp__d__render', args: {} }, { type: 'tool_result', id: 'a', name: 'mcp__d__render', result: 'plain text' }]);
    expect(within(card).getByText('plain text')).toBeInTheDocument();
    expect(card.querySelector('img, audio, video')).toBeNull();
  });

  it('titles the save_attachment tool', async () => {
    const card = await run([{ type: 'tool_start', id: 's', name: 'save_attachment', args: { attachment_id: 'ab', path: 'assets/logo.png' } }, { type: 'tool_result', id: 's', name: 'save_attachment', result: 'Saved render-1.png to assets/logo.png (33 bytes)' }]);
    expect(within(card).getByRole('button', { name: 'Saved assets/logo.png' })).toBeInTheDocument();
  });
});

describe('images the model generated', () => {
  const GEN = { id: 'g1', name: 'generated-1.png', kind: 'image' };

  it('agent: shows the image under the reply, with a download link', async () => {
    renderApp(<AgentPanel project={{ id: 7 }} />, { user: userWith(ALL), routes: { ...MODELS, 'POST /api/agent/turn': () => sse({ type: 'start', conversationId: 1 }, { type: 'media', attachments: [GEN] }, { type: 'text', text: 'Here is your banana' }, { type: 'done' }) } });
    await userEvent.type(await screen.findByLabelText('Message'), 'draw');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('img', { name: 'generated-1.png' })).toHaveAttribute('src', '/api/attachments/g1');
    expect(screen.getByText('Here is your banana')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download generated-1.png' })).toHaveAttribute('href', '/api/attachments/g1?download=1');
  });

  const chatRoutes = (extra = {}) => ({ '/api/models': { models: [{ id: 1, label: 'Fake' }], defaults: {} }, '/api/conversations': [{ id: 3, title: 'Bananas', modelId: 1 }], ...extra });

  it('chat: shows the image even when the reply has no text', async () => {
    renderApp(<Chat />, { user: userWith(ALL), routes: chatRoutes({ 'POST /api/chat/turn': () => sse({ type: 'start', conversationId: 3 }, { type: 'media', attachments: [GEN] }, { type: 'done' }) }) });
    await userEvent.type(await screen.findByLabelText('Message'), 'draw');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('img', { name: 'generated-1.png' })).toHaveAttribute('src', '/api/attachments/g1');
    expect(screen.getByRole('link', { name: 'Download generated-1.png' })).toBeInTheDocument();
  });

  it('chat: a saved conversation shows its images again', async () => {
    renderApp(<Chat />, { user: userWith(ALL), routes: chatRoutes({ '/api/conversations/3/messages': [{ role: 'user', content: 'draw' }, { role: 'assistant', content: 'done', attachments: [GEN] }] }) });
    await userEvent.click(await screen.findByText('Bananas'));
    expect(await screen.findByRole('img', { name: 'generated-1.png' })).toBeInTheDocument();
  });
});
