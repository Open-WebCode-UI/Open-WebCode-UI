import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { buildTheme, DEFAULT_BRANDING } from '../src/theme.js';
import { appendEvent, applyRun, isPython, serializeNotebook } from '../src/components/ide/notebook.js';

const api = vi.hoisted(() => ({ status: { enabled: true, canUse: true }, streamPost: vi.fn(), post: vi.fn(async () => ({ ok: true })) }));
vi.mock('../src/api.js', () => ({ get: vi.fn(async () => api.status), post: api.post, streamPost: api.streamPost, ApiError: class extends Error {} }));
const { default: NotebookEditor } = await import('../src/components/ide/NotebookEditor.jsx');
const { default: EditorMenuBar } = await import('../src/components/ide/EditorMenuBar.jsx');

const NB = { cells: [
  { cell_type: 'code', id: 'a', metadata: {}, execution_count: null, source: ['print("x")'], outputs: [] },
  { cell_type: 'code', id: 'b', metadata: {}, execution_count: null, source: ['1+1'], outputs: [] }], metadata: { kernelspec: { language: 'python' } }, nbformat: 4, nbformat_minor: 5 };

function Host({ initial = serializeNotebook(NB), editable = true }) {
  const [c, setC] = useState(initial); const [acts, setActs] = useState(null);
  const tab = { path: 'n/a.ipynb', preview: true, source: 'n/a.ipynb', content: c, saved: c };
  return <ThemeProvider theme={buildTheme(DEFAULT_BRANDING)}><EditorMenuBar editorRef={{ current: {} }} project={{ id: 7 }} tab={tab} tabs={[tab]} canWrite dirty prefs={{}} setPrefs={() => {}} notebook={acts} /><NotebookEditor onActions={setActs} project={{ id: 7 }} source="n/a.ipynb" content={c} editable={editable} dirty onChange={setC} onSave={() => {}} /><pre data-testid="raw">{c}</pre></ThemeProvider>;
}
const openMenu = () => userEvent.click(screen.getByRole('button', { name: 'Notebook' }));
const item = async (name) => { await openMenu(); return screen.findByRole('menuitem', { name }); };
const clickItem = async (name) => userEvent.click(await item(name));
const raw = () => JSON.parse(screen.getByTestId('raw').textContent);

beforeEach(() => { api.status = { enabled: true, canUse: true }; api.streamPost.mockReset(); api.post.mockClear(); });

describe('notebook run helpers', () => {
  it('folds kernel events into nbformat outputs and stores them on the right cell', () => {
    let o = [];
    for (const ev of [{ t: 'stream', name: 'stdout', text: 'a\n' }, { t: 'stream', name: 'stdout', text: 'b\n' }, { t: 'stream', name: 'stderr', text: 'e' }, { t: 'result', text: '3' }]) o = appendEvent(o, ev);
    expect(o.map((x) => x.output_type)).toEqual(['stream', 'stream', 'execute_result']); expect(o[0].text).toEqual(['a\n', 'b\n']);
    const nb = applyRun(NB, 'b', o, 4);
    expect(nb.cells[1]).toMatchObject({ execution_count: 4 }); expect(nb.cells[1].outputs[2].execution_count).toBe(4); expect(nb.cells[0].outputs).toEqual([]);
    expect(applyRun(NB, 'zzz', o, 1)).toBe(NB);
    const rich = appendEvent(appendEvent([], { t: 'display', data: { 'image/png': 'AAAA', 'text/plain': '<Figure>' } }), { t: 'result', data: { 'text/html': '<b>x</b>', 'text/plain': 'x' } });
    expect(rich.map((x) => x.output_type)).toEqual(['display_data', 'execute_result']); expect(rich[1].data['text/html']).toBe('<b>x</b>');
  });
  it('only treats python notebooks as runnable', () => {
    expect(isPython(NB)).toBe(true); expect(isPython({ metadata: {} })).toBe(true); expect(isPython({ metadata: { kernelspec: { language: 'R' } } })).toBe(false);
  });
});

describe('rich output while running', () => {
  it('shows an image and a table from a run', async () => {
    api.streamPost.mockImplementation(async (u, b, onEvent) => { onEvent({ t: 'display', data: { 'image/png': 'AAAA' } }); onEvent({ t: 'result', data: { 'text/html': '<table></table>', 'text/plain': 'df' } }); onEvent({ t: 'done', count: 1 }); });
    render(<Host />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run cell 1' }));
    const cell = screen.getAllByTestId('notebook-cell')[0];
    await vi.waitFor(() => expect(raw().cells[0].outputs).toHaveLength(2));
    expect(within(cell).getByAltText('Cell output')).toHaveAttribute('src', 'data:image/png;base64,AAAA'); expect(within(cell).getByTestId('html-output')).toBeInTheDocument();
  });
});

describe('run all', () => {
  const ok = (count) => async (u, b, onEvent) => { onEvent({ t: 'stream', name: 'stdout', text: `${b.code}\n` }); onEvent({ t: 'done', count }); };
  it('runs the code cells in order and stores each result', async () => {
    let n = 0; api.streamPost.mockImplementation(async (u, b, onEvent) => ok(++n)(u, b, onEvent));
    render(<Host />);
    await screen.findByRole('button', { name: 'Run cell 1' }); await clickItem('Run all');
    await vi.waitFor(() => expect(raw().cells[1].execution_count).toBe(2));
    expect(api.streamPost.mock.calls.map((c) => c[1].code)).toEqual(['print("x")', '1+1']);
    expect(raw().cells[0].outputs[0].text).toEqual(['print("x")\n']); expect(await item('Run all')).not.toHaveAttribute('aria-disabled', 'true');
  });
  it('stops at the first error', async () => {
    api.streamPost.mockImplementation(async (u, b, onEvent) => { onEvent({ t: 'error', ename: 'E', evalue: 'v', traceback: ['boom'] }); onEvent({ t: 'done', count: 1 }); });
    render(<Host />);
    await screen.findByRole('button', { name: 'Run cell 1' }); await clickItem('Run all');
    await vi.waitFor(() => expect(raw().cells[0].outputs[0].output_type).toBe('error'));
    expect(api.streamPost).toHaveBeenCalledTimes(1); expect(raw().cells[1].execution_count).toBeNull();
  });
  it('can be stopped, skips empty, and non-code cells, and is absent without run access', async () => {
    let finish; api.streamPost.mockImplementation((u, b, onEvent) => new Promise((resolve) => { finish = () => { onEvent({ t: 'error', ename: 'KeyboardInterrupt', evalue: '', traceback: ['x'] }); onEvent({ t: 'done', count: 1 }); resolve(); }; }));
    render(<Host />);
    await screen.findByRole('button', { name: 'Run cell 1' }); await clickItem('Run all');
    await clickItem('Stop');
    expect(api.post).toHaveBeenCalledWith('/api/terminal/kernel/interrupt', { projectId: 7, path: 'n/a.ipynb' });
    finish(); await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Run cell 1' })).toBeEnabled());  expect(api.streamPost).toHaveBeenCalledTimes(1);
  });
  it('is disabled for a notebook with no code', async () => {
    render(<Host initial={serializeNotebook({ ...NB, cells: [{ cell_type: 'markdown', metadata: {}, source: ['hi'] }, { ...NB.cells[0], source: ['  '] }] })} />);
    await screen.findByRole('button', { name: 'Notebook' }); expect(await item('Run all')).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('run button', () => {
  it('is absent unless the server allows shell use', async () => {
    api.status = { enabled: false, canUse: false }; render(<Host />);
    await screen.findByLabelText('Source of cell 1'); await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: /^Run cell/ })).toBeNull(); expect(screen.getByTestId('notebook-editor')).toHaveTextContent(/cannot be run/);
  });
  it('runs a cell, shows output as it streams, then stores it in the JSON', async () => {
    let finish;
    api.streamPost.mockImplementation((url, body, onEvent) => new Promise((resolve) => { onEvent({ t: 'stream', name: 'stdout', text: 'hello\n' }); finish = () => { onEvent({ t: 'done', count: 5 }); resolve(); }; }));
    render(<Host />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run cell 1' }));
    expect(api.streamPost).toHaveBeenCalledWith('/api/terminal/kernel/run', { projectId: 7, path: 'n/a.ipynb', code: 'print("x")' }, expect.any(Function), expect.anything());
    const cells = screen.getAllByTestId('notebook-cell');
    expect(await within(cells[0]).findByText('hello')).toBeInTheDocument(); expect(within(cells[0]).getByText('[*]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop cell 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run cell 2' })).toBeDisabled(); // one cell at a time
    expect(raw().cells[0].outputs).toEqual([]); // nothing is written until it finishes
    await userEvent.click(screen.getByRole('button', { name: 'Stop cell 1' }));
    expect(api.post).toHaveBeenCalledWith('/api/terminal/kernel/interrupt', { projectId: 7, path: 'n/a.ipynb' });
    finish();
    await vi.waitFor(() => expect(raw().cells[0].execution_count).toBe(5));
    expect(raw().cells[0].outputs[0]).toMatchObject({ output_type: 'stream', text: ['hello\n'] });
    expect(screen.getByRole('button', { name: 'Run cell 2' })).toBeEnabled();
  });
  it('keeps edits made while the cell was running', async () => {
    let finish;
    api.streamPost.mockImplementation((u, b, onEvent) => new Promise((resolve) => { finish = () => { onEvent({ t: 'done', count: 1 }); resolve(); }; }));
    render(<Host />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run cell 1' }));
    await userEvent.type(screen.getByLabelText('Source of cell 2'), '!');
    finish(); await vi.waitFor(() => expect(raw().cells[0].execution_count).toBe(1));
    expect(raw().cells[1].source).toEqual(['1+1!']);
  });
  it('shows a failure and can restart the kernel', async () => {
    api.streamPost.mockRejectedValue(Object.assign(new Error('x'), { body: { error: 'too_many_kernels' } }));
    render(<Host />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run cell 1' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many notebook kernels/);
    await clickItem('Restart kernel');
    expect(api.post).toHaveBeenCalledWith('/api/terminal/kernel/restart', { projectId: 7, path: 'n/a.ipynb' });
  });
});
