import { describe, it, expect, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, userWith, ALL } from './helpers.jsx';
import AgentPanel from '../src/components/AgentPanel.jsx';
import { formatTokens } from '../src/components/ModelPicker.jsx';

beforeEach(() => localStorage.clear());
const models = [
  { id: 1, modelId: 'claude-opus-5-5', label: 'Opus', provider: 'Anthropic', help: 'Best for hard problems.\nData stays in the EU.', contextSize: 200000, maxTokens: 8192, inputPrice: 5, outputPrice: 25.5, supportsThinking: true, supportsFiles: true, supportsImages: true },
  { id: 2, modelId: 'local-7b', label: 'Local 7B', provider: 'On-site', help: '', modelHelp: 'Fast, but weaker at refactoring.', supportsThinking: false },
];
const open = async (ms = models, defaults = { plan: 1 }) => {
  renderApp(<AgentPanel project={{ id: 9 }} />, { user: userWith(ALL), routes: { '/api/models': { models: ms, defaults }, '/api/skills': [] } });
  await userEvent.click(await screen.findByRole('button', { name: /^Model:/ }));
  return screen.findByRole('dialog');
};

describe('model picker dialog', () => {
  it('formats token counts', () => { expect([999, 8192, 200000, 1_000_000, 1_500_000].map(formatTokens)).toEqual(['999', '8K', '200K', '1M', '1.5M']); });
  it('collapses model details by default and reveals them with "Show more"', async () => {
    const dlg = await open();
    const opus = within(dlg).getByRole('radio', { name: /Opus/ });
    expect(opus).toHaveAttribute('aria-checked', 'true');
    for (const t of ['Default for Plan', 'Thinking', 'Files', 'Images']) expect(within(opus).getByText(t)).toBeInTheDocument();
    expect(within(dlg).getByText(/Best for hard problems\./)).toBeInTheDocument(); // provider help stays visible
    for (const t of ['claude-opus-5-5', /200K context/, /8K max reply/, /per 1M tokens/, 'Fast, but weaker at refactoring.']) expect(within(dlg).queryByText(t)).toBeNull();
    const more = within(dlg).getAllByRole('button', { name: 'Show more' });
    expect(more).toHaveLength(2);
    await userEvent.click(more[0]);
    for (const t of ['claude-opus-5-5', /200K context/, /8K max reply/, /\$5 in \/ \$25\.5 out per 1M tokens/]) expect(within(dlg).getByText(t)).toBeInTheDocument();
    expect(within(dlg).getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Show more' }));
    expect(within(dlg).getByText('Fast, but weaker at refactoring.')).toBeInTheDocument();
    expect(within(dlg).getAllByText(/per 1M tokens/)).toHaveLength(1); // no prices reported for Local 7B: nothing shown
  });
  it('holds the model settings and switches model', async () => {
    const dlg = await open();
    expect(within(dlg).getByRole('button', { name: 'Balanced' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dlg).getByRole('switch', { name: 'Thinking' })).toBeEnabled();
    await userEvent.click(within(dlg).getByRole('radio', { name: /Local 7B/ }));
    expect(within(dlg).getByRole('radio', { name: /Local 7B/ })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: /^Model:/ })).toHaveTextContent('Local 7B');
  });
});
