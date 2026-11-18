import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, userWith, ALL } from './helpers.jsx';

vi.mock('@monaco-editor/react', () => ({ default: () => <div data-testid="monaco" />, DiffEditor: () => <div /> }));
const { default: IDE } = await import('../src/pages/IDE.jsx');

beforeEach(() => localStorage.clear());

describe('an image picked in the Explorer', () => {
  it('opens read only in the editor instead of saying it is binary', async () => {
    renderApp(<IDE />, { user: userWith(ALL), routes: {
      '/api/projects': [{ id: 1, name: 'demo' }], '/api/projects/1/tree': [{ name: 'logo.png', path: 'logo.png', type: 'file' }], '/api/projects/1/checkpoints': [],
      '/api/models': { models: [{ id: 1, label: 'Fake', provider: 'p' }], defaults: {} }, '/api/skills': [],
    } });
    await userEvent.click(await screen.findByText('logo.png'));
    expect(await screen.findByRole('tab', { name: /logo\.png/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'logo.png' })).toHaveAttribute('src', '/api/projects/1/image?path=logo.png');
    expect(screen.queryByTestId('monaco')).toBeNull();
    expect(screen.queryByText(/Binary files cannot be edited here/)).toBeNull();
  });
});
