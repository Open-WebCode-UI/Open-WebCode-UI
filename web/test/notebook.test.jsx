import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import { buildTheme, DEFAULT_BRANDING } from '../src/theme.js';
import { previewPath } from '../src/components/ide/markdownPreview.js';
import { parseNotebook, serializeNotebook, setSource, insertCell, moveCell, deleteCell, setCellType, outputsOf, isNotebookPath } from '../src/components/ide/notebook.js';

vi.mock('@monaco-editor/react', () => ({ default: (p) => <div data-testid="monaco" data-path={p.path} />, DiffEditor: () => <div /> }));
const { default: EditorPane } = await import('../src/components/ide/EditorPane.jsx');

const NB = { cells: [
  { cell_type: 'markdown', id: 'a', metadata: {}, source: ['# Title\n', 'text'] },
  { cell_type: 'code', id: 'b', metadata: {}, execution_count: 3, source: ['print(1)'], outputs: [
    { output_type: 'stream', name: 'stdout', text: ['1\n'] },
    { output_type: 'display_data', data: { 'text/html': '<script>x</script>', 'text/plain': ['plain'] } },
    { output_type: 'error', ename: 'E', evalue: 'v', traceback: ['\u001b[31mboom\u001b[0m'] }] }],
  metadata: {}, nbformat: 4, nbformat_minor: 5 };
const JSON_TEXT = serializeNotebook(NB);

describe('notebook model', () => {
  it('recognizes notebooks and rejects bad input with a message', () => {
    expect(isNotebookPath('a/b.IPYNB')).toBe(true); expect(isNotebookPath('a.json')).toBe(false);
    expect(parseNotebook('{').error).toMatch(/Invalid JSON/); expect(parseNotebook('[]').error).toBeTruthy(); expect(parseNotebook('{}').error).toMatch(/cells/);
    expect(parseNotebook('  ').nb.cells).toEqual([]);
  });
  it('edits cells, keeping unknown fields and nbformat line arrays', () => {
    const nb = { ...NB, custom: 1 };
    expect(setSource(nb, 1, 'a\nb').cells[1].source).toEqual(['a\n', 'b']);
    expect(setSource(nb, 1, 'x').custom).toBe(1);
    const ins = insertCell(nb, 1, 'code'); expect(ins.cells).toHaveLength(3); expect(ins.cells[1].id).toBeTruthy(); expect(ins.cells[1].outputs).toEqual([]);
    expect(moveCell(nb, 0, 1).cells.map((c) => c.id)).toEqual(['b', 'a']); expect(moveCell(nb, 0, -1)).toBe(nb);
    expect(deleteCell(nb, 0).cells.map((c) => c.id)).toEqual(['b']);
    const md = setCellType(nb, 1, 'markdown').cells[1]; expect(md.outputs).toBeUndefined(); expect(md.source).toEqual(['print(1)']);
    expect(setCellType(nb, 0, 'code').cells[0].outputs).toEqual([]);
  });
  it('turns outputs into safe display items', () => {
    const o = outputsOf(NB.cells[1]);
    expect(o).toEqual([{ kind: 'text', stream: 'stdout', text: '1\n' }, { kind: 'html', html: '<script>x</script>' }, { kind: 'error', text: 'boom' }]);
    const img = outputsOf({ cell_type: 'code', outputs: [{ output_type: 'display_data', data: { 'image/png': 'AAAA' } }] })[0];
    expect(img.src).toBe('data:image/png;base64,AAAA');
    expect(outputsOf({ cell_type: 'code', outputs: [{ output_type: 'display_data', data: { 'image/png': '" onerror="x' } }] })).toEqual([]);
    const rich = (data) => outputsOf({ cell_type: 'code', outputs: [{ output_type: 'execute_result', data }] });
    expect(rich({ 'image/svg+xml': '<svg onload="x"/>', 'text/html': '<b>h</b>', 'text/plain': 'p' })[0]).toMatchObject({ kind: 'image', src: expect.stringMatching(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/) });
    expect(rich({ 'text/html': ['<b>', 'h</b>'], 'text/plain': 'p' })).toEqual([{ kind: 'html', html: '<b>h</b>' }]);
    expect(rich({ 'text/markdown': '# t', 'text/plain': 'p' })).toEqual([{ kind: 'markdown', text: '# t' }]);
    expect(rich({ 'text/latex': '$x$' })).toEqual([{ kind: 'text', stream: 'stdout', text: '$x$' }]);
  });
});

const SRC = { path: 'nb/a.ipynb', content: JSON_TEXT, saved: JSON_TEXT };
const PV = { path: previewPath('nb/a.ipynb'), source: 'nb/a.ipynb', preview: true, content: JSON_TEXT, saved: JSON_TEXT };
function pane(tabs, active, over = {}) {
  const p = { project: { id: 1 }, tabs, active, canWrite: true, defaultTheme: 'vs', onSelect: vi.fn(), onClose: vi.fn(), onCloseAll: vi.fn(), onChange: vi.fn(), onTabPatch: vi.fn(), onSave: vi.fn(), onSaveAll: vi.fn(), onNewFile: vi.fn(), onPreview: vi.fn(), ...over };
  return { p, ...render(<ThemeProvider theme={buildTheme(DEFAULT_BRANDING)}><EditorPane {...p} /></ThemeProvider>) };
}

describe('notebook editor tab', () => {
  it('is offered for an .ipynb tab', async () => {
    const { p } = pane([SRC], SRC.path);
    await userEvent.click(screen.getByRole('button', { name: 'Open notebook editor' }));
    expect(p.onPreview).toHaveBeenCalledWith('nb/a.ipynb');
    expect(screen.queryByRole('button', { name: 'Open Markdown preview' })).toBeNull();
  });
  it('renders cells and outputs without executing or injecting HTML', () => {
    pane([SRC, PV], PV.path);
    const view = screen.getByTestId('notebook-editor');
    expect(screen.queryByTestId('monaco')).toBeNull();
    expect(within(view).getAllByTestId('notebook-cell')).toHaveLength(2);
    expect(within(view).getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByLabelText('Source of cell 2')).toHaveValue('print(1)');
    expect(view.querySelector('script')).toBeNull(); expect(view).toHaveTextContent('boom');
    const frame = within(view).getByTestId('html-output'); // HTML output is isolated: sandboxed (no scripts) with a CSP that blocks the network
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin'); expect(frame.getAttribute('srcdoc')).toMatch(/default-src 'none'/);
  });
  it('writes edits back to the source JSON tab', async () => {
    const { p } = pane([SRC, PV], PV.path);
    await userEvent.type(screen.getByLabelText('Source of cell 2'), '!');
    const [path, json] = p.onChange.mock.calls.at(-1);
    expect(path).toBe('nb/a.ipynb'); expect(JSON.parse(json).cells[1].source).toEqual(['print(1)!']);
    await userEvent.click(screen.getByRole('button', { name: 'Code cell' }));
    expect(JSON.parse(p.onChange.mock.calls.at(-1)[1]).cells).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: 'Delete cell 1' }));
    expect(JSON.parse(p.onChange.mock.calls.at(-1)[1]).cells.map((c) => c.id)).toEqual(['b']);
  });
  it('saves the source file, and only when it has unsaved changes', async () => {
    const { p } = pane([SRC, PV], PV.path);
    await userEvent.click(screen.getByRole('button', { name: 'Notebook' })); expect(screen.getByRole('menuitem', { name: /^Save/ })).toHaveAttribute('aria-disabled', 'true'); await userEvent.keyboard('{Escape}');
    p.onSave.mockClear();
    pane([{ ...SRC, content: JSON_TEXT + ' ' }, PV], PV.path, { onSave: p.onSave });
    await userEvent.click(screen.getAllByRole('button', { name: 'Notebook' }).at(-1)); await userEvent.click(screen.getByRole('menuitem', { name: /^Save/ }));
    expect(p.onSave).toHaveBeenCalledWith('nb/a.ipynb');
  });
  it('is read-only without the source tab or write access, and explains invalid JSON', () => {
    pane([PV], PV.path);
    expect(screen.getByLabelText('Source of cell 2')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Code cell' })).toBeDisabled();
  });
  it('shows an error for invalid JSON', () => {
    const bad = { ...SRC, content: '{' };
    pane([bad, { ...PV, content: '{' }], PV.path);
    expect(screen.getByRole('alert')).toHaveTextContent(/Invalid JSON/);
  });
});

import { useState } from 'react';
import { applyFormat } from '../src/components/ide/markdownFormat.js';
import NotebookEditor from '../src/components/ide/NotebookEditor.jsx';

describe('markdown formatting', () => {
  const f = (t, a, b, k) => { const r = applyFormat(t, a, b, k); return [r.text, r.text.slice(r.start, r.end), r.start]; };
  it('wraps a selection and keeps it selected; an empty selection leaves the caret between the markers', () => {
    expect(f('a word b', 2, 6, 'bold')).toEqual(['a **word** b', 'word', 4]);
    expect(f('x', 1, 1, 'italic')).toEqual(['x**', '', 2 - 1 + 1]);
    expect(f('', 0, 0, 'code')).toEqual(['``', '', 1]);
    expect(f('a b', 0, 1, 'strike')[0]).toBe('~~a~~ b');
  });
  it('toggles formatting off again', () => {
    expect(f('a **word** b', 4, 8, 'bold')).toEqual(['a word b', 'word', 2]);
    expect(f('**word**', 0, 8, 'bold')).toEqual(['word', 'word', 0]);
    expect(f('****', 2, 2, 'bold')[0]).toBe('');
  });
  it('fences a code block with the caret on the line inside', () => {
    expect(f('', 0, 0, 'codeBlock')).toEqual(['```\n\n```', '', 4]);
    expect(f('a\nfoo', 2, 5, 'codeBlock')).toEqual(['a\n```\nfoo\n```', 'foo', 6]);
    expect(f('see x', 4, 5, 'codeBlock')[0]).toBe('see \n```\nx\n```');
  });
  it('prefixes and un-prefixes whole lines', () => {
    expect(applyFormat('a\nb', 0, 3, 'bullet').text).toBe('- a\n- b');
    expect(applyFormat('- a\n- b', 0, 7, 'bullet').text).toBe('a\nb');
    expect(applyFormat('a\nb', 0, 3, 'numbered').text).toBe('1. a\n2. b');
    expect(applyFormat('a', 1, 1, 'quote')).toMatchObject({ text: '> a', start: 3 });
    expect(applyFormat('# a', 0, 3, 'heading').text).toBe('## a');
    expect(applyFormat('## a', 0, 4, 'heading').text).toBe('a');
  });
});

function Stateful({ initial }) {
  const [c, setC] = useState(initial);
  return <><NotebookEditor source="a.ipynb" content={c} editable dirty onChange={setC} onSave={() => {}} /><pre data-testid="raw">{c}</pre></>;
}
const rawNb = () => JSON.parse(screen.getByTestId('raw').textContent);

describe('notebook insert-between and format bar', () => {
  it('inserts a cell at the hovered gap', async () => {
    render(<ThemeProvider theme={buildTheme(DEFAULT_BRANDING)}><Stateful initial={JSON_TEXT} /></ThemeProvider>);
    expect(screen.getAllByTestId('cell-gap')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Insert markdown cell at position 2' }));
    expect(rawNb().cells.map((c) => c.cell_type)).toEqual(['markdown', 'markdown', 'code']);
    await userEvent.click(screen.getByRole('button', { name: 'Insert code cell at position 1' }));
    expect(rawNb().cells.map((c) => c.cell_type)).toEqual(['code', 'markdown', 'markdown', 'code']);
  });
  it('formats a markdown cell from the bar and puts the caret back', async () => {
    render(<ThemeProvider theme={buildTheme(DEFAULT_BRANDING)}><Stateful initial={JSON_TEXT} /></ThemeProvider>);
    expect(screen.queryByRole('toolbar')).toBeNull(); // markdown cells are rendered until edited
    await userEvent.dblClick(screen.getByTestId('rendered-markdown'));
    const bar = screen.getByRole('toolbar', { name: 'Formatting for cell 1' });
    const ta = screen.getByLabelText('Source of cell 1');
    ta.setSelectionRange(2, 7); // "Title"
    await userEvent.click(within(bar).getByRole('button', { name: 'Bold' }));
    expect(rawNb().cells[0].source.join('')).toBe('# **Title**\ntext');
    expect(screen.getByLabelText('Source of cell 1')).toHaveFocus();
    expect(ta.selectionStart).toBe(4); expect(ta.selectionEnd).toBe(9);
    expect(within(screen.getByTestId('notebook-editor')).queryAllByRole('toolbar')).toHaveLength(1); // code cells get no bar
  });
});
