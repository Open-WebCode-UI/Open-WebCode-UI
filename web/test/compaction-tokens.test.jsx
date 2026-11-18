import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, within } from '@testing-library/react';
import { renderApp, userWith, ALL } from './helpers.jsx';
import { CompactedCard, tokenNote } from '../src/components/AgentItems.jsx';

afterEach(cleanup);

describe('the compaction card', () => {
  it('says how many tokens were freed, and the context before and after', () => {
    renderApp(<CompactedCard item={{ archived: 3, summary: 'Goal', tokens: { before: 52410, after: 11180, freed: 41230 } }} />, { user: userWith(ALL) });
    const card = screen.getByTestId('compacted');
    expect(within(card).getByText('Context compacted: 3 earlier messages summarized')).toBeInTheDocument();
    expect(within(card).getByText('Freed 41,230 tokens: the context went from 52,410 to 11,180.')).toBeInTheDocument();
  });
  it('says when a summary is longer than what it replaced, instead of claiming tokens were freed', () => {
    expect(tokenNote({ before: 100, after: 150, freed: -50 })).toBe('The summary is 50 tokens longer than the context it replaced (100 to 150).');
  });
  it('shows no token line for a compaction recorded before the counts existed', () => {
    renderApp(<CompactedCard item={{ archived: 2, summary: 'Goal' }} />, { user: userWith(ALL) });
    expect(screen.getByTestId('compacted').textContent).not.toMatch(/tokens/);
  });
});
