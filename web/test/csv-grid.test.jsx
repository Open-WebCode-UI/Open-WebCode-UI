import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, userWith, ALL } from './helpers.jsx';

vi.mock('@monaco-editor/react', () => ({ default: () => <div data-testid="monaco" />, DiffEditor: () => <div /> }));
const { default: IDE } = await import('../src/pages/IDE.jsx');

beforeEach(() => localStorage.clear());

const open = async () => {
  renderApp(<IDE />, { user: userWith(ALL), routes: {
    '/api/projects': [{ id: 1, name: 'demo' }], '/api/projects/1/tree': [{ name: 'data.csv', path: 'data.csv', type: 'file' }], '/api/projects/1/checkpoints': [],
    '/api/projects/1/file': { path: 'data.csv', content: 'Name,Age\nAda,36\n' },
    '/api/models': { models: [{ id: 1, label: 'Fake', provider: 'p' }], defaults: {} }, '/api/skills': [],
  } });
  await userEvent.click(await screen.findByText('data.csv'));
  await screen.findByRole('tab', { name: /data\.csv/ });
};

describe('CSV files in the editor', () => {
  it('opens as text by default, and the Grid view edits the same file', async () => {
    await open();
    expect(screen.getByTestId('monaco')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Grid' }));
    expect(screen.queryByTestId('monaco')).toBeNull();
    expect(screen.getByRole('columnheader', { name: /^A/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Row 2, column B')).toHaveValue('36');
    expect(screen.getByLabelText('Row 1, column A')).toHaveValue('Name');
  });

  it('a cell edit marks the file unsaved; adding a row and a column keeps the file a CSV', async () => {
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Grid' }));
    const age = screen.getByLabelText('Row 2, column B');
    await userEvent.clear(age); await userEvent.type(age, '37');
    expect(screen.getByLabelText('Row 2, column B')).toHaveValue('37');
    expect(screen.getByRole('tab', { name: /data\.csv •/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add row' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add column' }));
    expect(screen.getByText('3 rows, 3 columns')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Text' }));
    expect(screen.getByTestId('monaco')).toBeInTheDocument();
  });
});

describe('CSV grid context menus', () => {
  const grid = async (content = 'Name,Age\nAda,36\n') => {
    renderApp(<IDE />, { user: userWith(ALL), routes: {
      '/api/projects': [{ id: 1, name: 'demo' }], '/api/projects/1/tree': [{ name: 'data.csv', path: 'data.csv', type: 'file' }], '/api/projects/1/checkpoints': [],
      '/api/projects/1/file': { path: 'data.csv', content },
      '/api/models': { models: [{ id: 1, label: 'Fake', provider: 'p' }], defaults: {} }, '/api/skills': [],
    } });
    await userEvent.click(await screen.findByText('data.csv'));
    await screen.findByRole('tab', { name: /data\.csv/ });
    await userEvent.click(screen.getByRole('button', { name: 'Grid' }));
  };
  const menuOn = (el, name) => { fireEvent.contextMenu(el); return screen.getByRole('menuitem', { name }); };

  it('a row menu inserts and deletes rows', async () => {
    await grid();
    await userEvent.click(menuOn(screen.getByRole('rowheader', { name: '2' }), 'Insert row above'));
    expect(screen.getByText('3 rows, 2 columns')).toBeInTheDocument();
    await userEvent.click(menuOn(screen.getByRole('rowheader', { name: '3' }), 'Delete row'));
    expect(screen.getByText('2 rows, 2 columns')).toBeInTheDocument();
  });

  it('a column menu inserts a column to the right', async () => {
    await grid();
    await userEvent.click(menuOn(screen.getByRole('columnheader', { name: 'B' }), 'Insert column right'));
    expect(screen.getByText('2 rows, 3 columns')).toBeInTheDocument();
    expect(screen.getByLabelText('Row 1, column C')).toHaveValue('');
  });

  it('a cell menu merges a selected range into its top-left cell', async () => {
    await grid();
    fireEvent.mouseDown(screen.getByLabelText('Row 1, column A'), { button: 0 });
    fireEvent.mouseDown(screen.getByLabelText('Row 2, column B'), { button: 0, shiftKey: true });
    await userEvent.click(menuOn(screen.getByLabelText('Row 2, column A'), 'Merge cells'));
    expect(screen.getByLabelText('Row 1, column A')).toHaveValue('Name Age Ada 36');
    expect(screen.getByLabelText('Row 1, column B')).toHaveValue('');
    expect(screen.getByLabelText('Row 2, column B')).toHaveValue('');
  });

  it('merging a single cell is not offered as an action', async () => {
    await grid();
    expect(menuOn(screen.getByLabelText('Row 2, column B'), 'Merge cells')).toHaveAttribute('aria-disabled', 'true');
  });
});
