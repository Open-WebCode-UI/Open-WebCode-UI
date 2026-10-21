import { describe, it, expect, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Servers from '../src/pages/admin/Servers.jsx';
import ModelBadges from '../src/components/ModelBadges.jsx';
import AgentPanel from '../src/components/AgentPanel.jsx';
import { renderApp, userWith, ALL, ADMIN } from './helpers.jsx';

beforeEach(() => localStorage.clear());
const model = { id: 11, modelId: 'big-1', label: 'Big', enabled: true, maxTokens: 4096, subagents: true, badgeIds: [2] };
const provider = { id: 4, name: 'Acme', type: 'openai', enabled: true, config: {}, allowedRoles: [], helpText: '', models: [model] };
const badges = {
  categories: [{ id: 1, name: 'Data tier' }, { id: 2, name: 'Good at' }],
  badges: [{ id: 1, categoryId: 1, label: 'Tier 2', description: 'Internal data.', color: 'orange' }, { id: 2, categoryId: 2, label: 'Coding', description: '', color: 'blue' }, { id: 3, categoryId: null, label: 'New', description: '', color: 'gray' }],
};
const routes = { '/api/admin/providers': [provider], '/api/admin/roles': { roles: [], groupMap: [] }, '/api/models': { models: [], defaults: {} }, '/api/admin/badges': badges };

describe('badges: admin', () => {
  it('shows a model\'s badges and lets a permitted admin attach them from the model dialog', async () => {
    const { fetch } = renderApp(<Servers />, { user: userWith(ADMIN), routes: { ...routes, 'PUT /api/admin/models/11/badges': { badgeIds: [2, 1] }, 'POST /api/admin/providers/4/models': provider } });
    const row = (await screen.findByText('Big')).closest('tr');
    expect(await within(row).findByText('Coding')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Edit Big' }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('combobox', { name: /Badges/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Tier 2' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'PUT' && c.url === '/api/admin/models/11/badges')?.body).toEqual({ badgeIds: [2, 1], featuredBadgeId: null }));
  });
  it('only offers the model\'s own badges as the featured badge, and drops it when that badge is removed', async () => {
    const withFeatured = { ...provider, models: [{ ...model, badgeIds: [1, 2], featuredBadgeId: 2 }] };
    const { fetch } = renderApp(<Servers />, { user: userWith(ADMIN), routes: { ...routes, '/api/admin/providers': [withFeatured], 'PUT /api/admin/models/11/badges': {}, 'POST /api/admin/providers/4/models': withFeatured } });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Big' }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('combobox', { name: 'Featured badge' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['None', 'Tier 2', 'Coding']); // not "New": it is not assigned
    await userEvent.keyboard('{Escape}');
    const chip = within(dlg).getAllByText('Coding').map((e) => e.closest('.MuiChip-root')).find(Boolean); // the tag in the Badges field
    await userEvent.click(chip.querySelector('.MuiChip-deleteIcon'));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'PUT' && c.url === '/api/admin/models/11/badges')?.body).toEqual({ badgeIds: [1], featuredBadgeId: null }));
  });
  it('creates a category and a badge in "Manage badges"', async () => {
    const { fetch } = renderApp(<Servers />, { user: userWith(ADMIN), routes: { ...routes, 'POST /api/admin/badge-categories': { id: 9, name: 'Region' }, 'POST /api/admin/badges': { id: 9 } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Manage badges' }));
    const dlg = await screen.findByRole('dialog', { name: /Badges/ });
    expect(within(dlg).getByRole('region', { name: 'Category Data tier' })).toBeInTheDocument();
    expect(within(dlg).getByRole('region', { name: 'Uncategorized' })).toBeInTheDocument();
    await userEvent.type(within(dlg).getByLabelText('New category'), 'Region');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.url === '/api/admin/badge-categories')?.body).toEqual({ name: 'Region' }));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Add badge to Good at' }));
    await userEvent.type(await screen.findByRole('textbox', { name: 'Label' }), 'Writing');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'POST' && c.url === '/api/admin/badges')?.body).toEqual({ label: 'Writing', description: '', color: 'gray', categoryId: 2 }));
  });
  it('hides management without provider.write', async () => {
    renderApp(<Servers />, { user: userWith([...ALL, 'provider.read']), routes });
    await screen.findByText('Big');
    expect(screen.queryByRole('button', { name: 'Manage badges' })).toBeNull();
  });
});

describe('badges: model picker', () => {
  const b = (id, label, category, color = 'blue') => ({ id, label, description: '', color, category });
  it('shows only the featured badge on the card, and every badge by category under "Show more"', async () => {
    const models = [
      { id: 1, modelId: 'a', label: 'Opus', provider: 'Anthropic', help: '', featuredBadgeId: 1, badges: [b(1, 'Tier 2', 'Data tier', 'orange'), b(2, 'Coding', 'Good at'), b(3, 'Writing', 'Good at'), b(4, 'New', null, 'gray')] },
      { id: 2, modelId: 'b', label: 'Plain', provider: 'Anthropic', help: '', featuredBadgeId: null, badges: [b(2, 'Coding', 'Good at')] },
    ];
    renderApp(<AgentPanel project={{ id: 9 }} />, { user: userWith(ALL), routes: { '/api/models': { models, defaults: { plan: 1 } }, '/api/skills': [] } });
    await userEvent.click(await screen.findByRole('button', { name: /^Model:/ }));
    const dlg = await screen.findByRole('dialog');
    const opus = within(dlg).getByRole('radio', { name: /Opus/ });
    expect(within(opus).getByText('Tier 2')).toBeInTheDocument(); // featured: visible while collapsed
    for (const t of ['Coding', 'Writing', 'New', 'Good at']) expect(within(dlg).queryAllByText(t).filter((e) => opus.parentElement.contains(e))).toHaveLength(0);
    expect(within(dlg).queryByText('Coding')).toBeNull(); // Plain has a badge but none featured: nothing shown while collapsed
    await userEvent.click(within(dlg).getAllByRole('button', { name: 'Show more' })[0]);
    const good = within(dlg).getByRole('region', { name: 'Good at badges' });
    expect(within(good).getAllByText(/^(Coding|Writing)$/).map((e) => e.textContent)).toEqual(['Coding', 'Writing']);
    expect(within(dlg).getByRole('region', { name: 'Data tier badges' })).toHaveTextContent('Tier 2');
    expect(within(dlg).getByRole('region', { name: 'Other badges' })).toHaveTextContent('New');
    const sections = within(dlg).getAllByRole('region').map((r) => r.getAttribute('aria-label')).filter((n) => /badges$/.test(n));
    expect(sections).toEqual(['Data tier badges', 'Good at badges', 'Other badges']);
  });
  it('offers "Show more" for a model whose only detail is its badges', async () => {
    const models = [{ id: 1, modelId: '', label: 'Solo', provider: 'P', help: '', featuredBadgeId: null, badges: [b(2, 'Coding', 'Good at')] }];
    renderApp(<AgentPanel project={{ id: 9 }} />, { user: userWith(ALL), routes: { '/api/models': { models, defaults: {} }, '/api/skills': [] } });
    await userEvent.click(await screen.findByRole('button', { name: /^Model:/ }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).queryByText('Coding')).toBeNull();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Show more' }));
    expect(within(dlg).getByText('Coding')).toBeInTheDocument();
  });
});

describe('badge colors', () => {
  it('use fixed colors that ignore the branding theme (the test theme\'s primary is #112233)', () => {
    renderApp(<ModelBadges badges={[{ id: 1, label: 'Blue one', color: 'blue' }, { id: 2, label: 'Odd', color: 'nonsense' }]} />, {});
    const blue = screen.getByLabelText('Blue one'), odd = screen.getByLabelText('Odd');
    expect(getComputedStyle(blue).color).toBe('rgb(29, 78, 216)');
    expect(getComputedStyle(blue).color).not.toBe('rgb(17, 34, 51)');
    expect(odd).toHaveAttribute('data-color', 'gray'); // an unknown color falls back to gray
  });
});
