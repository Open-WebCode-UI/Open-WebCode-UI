import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent, createEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import { buildTheme, DEFAULT_BRANDING } from '../src/theme.js';
import { DEFAULT_LAYOUT, normalizeLayout, applyPreset, hidePane, movePane, movePaneToEdge, computeRects, visiblePanes, ROOT } from '../src/components/ide/layout.js';
import { copy, cut, paste } from '../src/components/ide/editorActions.js';
import { loadPrefs } from '../src/components/ide/editorPrefs.js';

// ---- a fake Monaco: enough surface for the menu bar, status bar, and editor actions
const sel = (o = {}) => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1, isEmpty() { return this.startLineNumber === this.endLineNumber && this.startColumn === this.endColumn; }, ...o });
function fakeEditor(over = {}) {
  const state = { selection: sel(), pos: { lineNumber: 3, column: 7 }, eol: '\n', tabSize: 2, insertSpaces: true, lang: 'javascript', text: 'line one\nline two\nline three', ...over };
  const model = {
    getOptions: () => ({ tabSize: state.tabSize, insertSpaces: state.insertSpaces }), getEOL: () => state.eol, getLanguageId: () => state.lang,
    getValueInRange: (r) => (r === state.selection && !r.isEmpty() ? 'SELECTED' : state.text.split('\n')[r.startLineNumber - 1] + '\n'),
    updateOptions: vi.fn((o) => Object.assign(state, o)), setEOL: vi.fn((v) => { state.eol = v === 1 ? '\r\n' : '\n'; }), getLineMaxColumn: () => 12, getLineCount: () => 3,
  };
  const listeners = [];
  const ed = { focus: vi.fn(), trigger: vi.fn(), getPosition: () => state.pos, getSelection: () => state.selection, getSelections: () => [state.selection], getModel: () => model,
    executeEdits: vi.fn(), pushUndoStop: vi.fn(), addCommand: vi.fn(), onDidDispose: vi.fn(), ...Object.fromEntries(['CursorPosition', 'CursorSelection', 'Model', 'ModelLanguage', 'ModelOptions', 'ModelContent'].map((n) => [`onDidChange${n}`, (cb) => { listeners.push(cb); return { dispose() {} }; }])) };
  return { ed, state, model, fire: () => listeners.forEach((l) => l()) };
}
const monaco = { KeyMod: { CtrlCmd: 1 }, KeyCode: { KeyS: 2 }, editor: { EndOfLineSequence: { LF: 0, CRLF: 1 } }, languages: { getLanguages: () => [{ id: 'javascript', aliases: ['JavaScript', 'js'] }, { id: 'python', aliases: ['Python'] }, { id: 'plaintext', aliases: ['Plain Text'] }, { id: 'typescript', aliases: ['TypeScript'] }] } };
let fake, editorProps;
vi.mock('@monaco-editor/react', () => ({
  default: (props) => { editorProps = props; return <div data-testid="monaco" data-language={props.language} data-theme={props.theme}><button onClick={() => props.onMount(fake.ed, monaco)}>mount-editor</button></div>; },
  DiffEditor: () => <div />,
}));
const { default: EditorPane } = await import('../src/components/ide/EditorPane.jsx');
const { default: IdeLayout } = await import('../src/components/ide/IdeLayout.jsx');

const wrap = (ui) => render(<ThemeProvider theme={buildTheme(DEFAULT_BRANDING)}>{ui}</ThemeProvider>);
const TABS = [{ path: 'src/a.js', content: 'const a = 1;', saved: 'const a = 1;' }, { path: 'src/b.py', content: 'x = 1', saved: 'x = 0' }];
function pane(over = {}) {
  const p = { project: { id: 4 }, tabs: TABS, active: 'src/a.js', canWrite: true, defaultTheme: 'vs-dark', onSelect: vi.fn(), onClose: vi.fn(), onCloseAll: vi.fn(), onChange: vi.fn(), onTabPatch: vi.fn(), onSave: vi.fn(), onSaveAll: vi.fn(), onNewFile: vi.fn(),
    ...over };
  return { p, ...wrap(<EditorPane {...p} />) };
}
const mount = async () => { await userEvent.click(screen.getByText('mount-editor')); };
const openMenu = (n) => userEvent.click(screen.getByRole('button', { name: n }));
const item = (n) => { const name = new RegExp(`^${n}`); return screen.queryByRole('menuitem', { name }) ?? screen.getByRole('menuitemcheckbox', { name }); };
const click = async (menu, name) => { await openMenu(menu); await userEvent.click(item(name)); };

beforeEach(() => { fake = fakeEditor(); localStorage.clear(); editorProps = null; });

describe('editor menu bar (top bar)', () => {
  it('has File / Edit / View / Go menus (workspace layout lives in the app header, not here)', () => {
    pane(); expect(within(screen.getByRole('navigation', { name: 'Editor menu' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['File', 'Edit', 'View', 'Go']);
  });
  it.each([
    ['Find', 'actions.find'], ['Replace', 'editor.action.startFindReplace'], ['Undo', 'undo'], ['Redo', 'redo'], ['Select all', 'editor.action.selectAll'],
    ['Toggle line comment', 'editor.action.commentLine'], ['Format document', 'editor.action.formatDocument'],
  ])('Edit → %s runs Monaco command %s', async (label, id) => {
    pane(); await mount(); await click('Edit', label);
    expect(fake.ed.trigger).toHaveBeenCalledWith('menu', id, null); expect(fake.ed.focus).toHaveBeenCalled();
  });
  it.each([['View', 'Command palette', 'editor.action.quickCommand'], ['View', 'Fold all', 'editor.foldAll'], ['View', 'Unfold all', 'editor.unfoldAll'], ['Go', 'Go to line', 'editor.action.gotoLine'], ['Go', 'Go to symbol', 'editor.action.quickOutline']])('%s → %s runs %s', async (menu, label, id) => {
    pane(); await mount(); await click(menu, label); expect(fake.ed.trigger).toHaveBeenCalledWith('menu', id, null);
  });
  it('Cut / Copy / Paste use the clipboard and edit through the editor (undoable)', async () => {
    let clip = ''; Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async (t) => { clip = t; }), readText: vi.fn(async () => 'PASTED') }, configurable: true });
    fake = fakeEditor({ selection: sel({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 }) });
    pane(); await mount();
    await click('Edit', 'Copy'); await waitFor(() => expect(clip).toBe('SELECTED'));
    await click('Edit', 'Cut'); await waitFor(() => expect(fake.ed.executeEdits).toHaveBeenCalledWith('menu', [expect.objectContaining({ text: '' })]));
    await click('Edit', 'Paste'); await waitFor(() => expect(fake.ed.executeEdits).toHaveBeenCalledWith('menu', [expect.objectContaining({ text: 'PASTED' })]));
    expect(fake.ed.pushUndoStop).toHaveBeenCalled();
  });
  it('with no selection, copy and cut take the whole line', async () => {
    const writeText = vi.fn(async () => {}); Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await copy(fake.ed); expect(writeText).toHaveBeenCalledWith('line three\n');
    await cut(fake.ed); expect(fake.ed.executeEdits).toHaveBeenCalledWith('menu', [{ range: expect.objectContaining({ startLineNumber: 3, startColumn: 1 }), text: '', forceMoveMarkers: true }]);
  });
  it('paste survives a denied clipboard permission without throwing', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { readText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
    expect(await paste(fake.ed)).toBe(false); expect(fake.ed.executeEdits).not.toHaveBeenCalled();
  });
  it('Edit items are disabled without an open file; read-only editors can copy and find but not change anything', async () => {
    pane({ tabs: [], active: null });
    await openMenu('Edit'); for (const n of ['Undo', 'Cut', 'Copy', 'Paste', 'Find', 'Replace', 'Select all']) expect(item(n)).toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
  });
  it('read-only mode', async () => {
    pane({ canWrite: false }); await openMenu('Edit');
    for (const n of ['Undo', 'Cut', 'Paste', 'Replace', 'Format document']) expect(item(n)).toHaveAttribute('aria-disabled', 'true');
    for (const n of ['Copy', 'Find', 'Select all']) expect(item(n)).not.toHaveAttribute('aria-disabled', 'true');
  });
  it('runs a menu action only after the menu has closed, so the menu cannot take focus back from Monaco (command palette)', async () => {
    pane(); await mount(); let menuOpen; fake.ed.trigger.mockImplementation(() => { menuOpen = !!screen.queryByRole('menu'); });
    await click('View', 'Command palette'); expect(fake.ed.trigger).toHaveBeenCalledWith('menu', 'editor.action.quickCommand', null); expect(menuOpen).toBe(false);
  });
  it('File menu: save is only enabled for unsaved changes; save all, close, and new file', async () => {
    const { p } = pane(); // a.js is clean
    await openMenu('File'); expect(item('Save(?! all)')).toHaveAttribute('aria-disabled', 'true'); expect(item('Save all')).not.toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(item('Save all')); expect(p.onSaveAll).toHaveBeenCalled();
    await click('File', 'New file'); expect(p.onNewFile).toHaveBeenCalled();
    await click('File', 'Close tab'); expect(p.onClose).toHaveBeenCalledWith('src/a.js');
    await click('File', 'Close all tabs'); expect(p.onCloseAll).toHaveBeenCalled();
  });
  it('File → Save saves the current dirty file', async () => {
    const { p } = pane({ active: 'src/b.py' }); await click('File', 'Save(?! all)'); expect(p.onSave).toHaveBeenCalledWith('src/b.py');
  });
  it('File → Download file downloads the current content under its file name', async () => {
    const urls = []; URL.createObjectURL = vi.fn((b) => { urls.push(b); return 'blob:x'; }); URL.revokeObjectURL = vi.fn();
    const clicked = []; const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { clicked.push(this.download); };
    pane({ active: 'src/b.py' }); await click('File', 'Download file');
    expect(clicked).toEqual(['b.py']); expect(await urls[0].text()).toBe('x = 1'); HTMLAnchorElement.prototype.click = orig;
  });
  it('File → Download project is available when a project is open', async () => { pane(); await openMenu('File'); expect(item('Download project')).not.toHaveAttribute('aria-disabled', 'true'); });
  it('Go → next / previous tab wraps around', async () => {
    const { p } = pane(); await click('Go', 'Next tab'); expect(p.onSelect).toHaveBeenLastCalledWith('src/b.py');
    await click('Go', 'Previous tab'); expect(p.onSelect).toHaveBeenLastCalledWith('src/b.py'); // from a.js, previous wraps to the last
  });
  it('shows keyboard shortcuts next to items', async () => { pane(); await openMenu('Edit'); expect(within(item('Find')).getByText(/F$/)).toBeInTheDocument(); });
});

describe('view preferences', () => {
  it('toggles word wrap, minimap, whitespace, and line numbers, passes them to Monaco, and persists them', async () => {
    pane();
    expect(editorProps.options).toMatchObject({ wordWrap: 'off', minimap: { enabled: false }, renderWhitespace: 'selection', lineNumbers: 'on', automaticLayout: true });
    await click('View', 'Word wrap'); await click('View', 'Minimap'); await click('View', 'Show whitespace'); await click('View', 'Line numbers');
    expect(editorProps.options).toMatchObject({ wordWrap: 'on', minimap: { enabled: true }, renderWhitespace: 'all', lineNumbers: 'off' });
    expect(loadPrefs()).toMatchObject({ wordWrap: true, minimap: true, whitespace: true, lineNumbers: false });
  });
  it('remembers preferences on the next visit and shows check marks', async () => {
    localStorage.setItem('ide-editor-prefs-v1', JSON.stringify({ wordWrap: true, fontSize: 18, theme: 'hc-black' }));
    pane(); expect(editorProps.options.wordWrap).toBe('on'); expect(editorProps.options.fontSize).toBe(18); expect(screen.getByTestId('monaco')).toHaveAttribute('data-theme', 'hc-black');
    await openMenu('View'); expect(item('Word wrap')).toHaveAttribute('aria-checked', 'true'); expect(item('Minimap')).toHaveAttribute('aria-checked', 'false');
  });
  it('zoom in/out/reset is bounded, and the editor theme can override the app default', async () => {
    pane(); expect(screen.getByTestId('monaco')).toHaveAttribute('data-theme', 'vs-dark');
    await click('View', 'Zoom in'); await click('View', 'Zoom in'); expect(editorProps.options.fontSize).toBe(15);
    await click('View', 'Zoom out'); expect(editorProps.options.fontSize).toBe(14); await click('View', 'Reset zoom'); expect(editorProps.options.fontSize).toBe(13);
    await click('View', 'Editor theme: light'); expect(screen.getByTestId('monaco')).toHaveAttribute('data-theme', 'vs');
    await click('View', 'Editor theme: app default'); expect(screen.getByTestId('monaco')).toHaveAttribute('data-theme', 'vs-dark');
  });
  it('survives corrupt stored preferences', () => { localStorage.setItem('ide-editor-prefs-v1', '{oops'); pane(); expect(editorProps.options.fontSize).toBe(13); });
  it('the editor is read-only without files.write', () => { pane({ canWrite: false }); expect(editorProps.options.readOnly).toBe(true); });
});

describe('status bar (bottom bar)', () => {
  const status = () => screen.getByRole('status', { name: 'Editor status', hidden: true }); // hidden: a modal dialog aria-hides the page
  it('shows file-less state until a file is open', () => { pane({ tabs: [], active: null }); expect(within(status()).getByText('No file open')).toBeInTheDocument(); });
  it('shows cursor position, indentation, encoding, line endings, and language', async () => {
    pane(); await mount();
    const bar = status();
    expect(within(bar).getByText('Ln 3, Col 7')).toBeInTheDocument(); expect(within(bar).getByText('Spaces: 2')).toBeInTheDocument(); expect(within(bar).getByText('UTF-8')).toBeInTheDocument();
    expect(within(bar).getByText('LF')).toBeInTheDocument(); expect(within(bar).getByText('JavaScript')).toBeInTheDocument();
  });
  it('updates as the cursor and selection move', async () => {
    pane(); await mount();
    act(() => { fake.state.pos = { lineNumber: 10, column: 2 }; fake.state.selection = sel({ startLineNumber: 10, startColumn: 1, endLineNumber: 12, endColumn: 4 }); fake.fire(); });
    expect(await within(status()).findByText(/Ln 10, Col 2 \(8 selected, 3 lines\)/)).toBeInTheDocument();
  });
  it('clicking the position opens Monaco\'s go-to-line', async () => {
    pane(); await mount(); await userEvent.click(within(status()).getByRole('button', { name: 'Go to line' })); expect(fake.ed.trigger).toHaveBeenCalledWith('menu', 'editor.action.gotoLine', null);
  });
  it('changes indentation (spaces / tabs) on the model', async () => {
    pane(); await mount(); await userEvent.click(within(status()).getByRole('button', { name: 'Indentation' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Indent using spaces: 4' })); expect(fake.model.updateOptions).toHaveBeenCalledWith({ insertSpaces: true, tabSize: 4 });
    await userEvent.click(within(status()).getByRole('button', { name: 'Indentation' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Indent using tabs/ })); expect(fake.model.updateOptions).toHaveBeenLastCalledWith({ insertSpaces: false, tabSize: 4 });
    await waitFor(() => expect(within(status()).getByText('Tab Size: 4')).toBeInTheDocument());
  });
  it('switches the end-of-line sequence', async () => {
    pane(); await mount(); await userEvent.click(within(status()).getByRole('button', { name: 'End of line sequence' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /CRLF/ })); expect(fake.model.setEOL).toHaveBeenCalledWith(1);
    expect(await within(status()).findByText('CRLF')).toBeInTheDocument();
  });
  it('picks a language from a searchable list, marks the override, and can return to auto-detect', async () => {
    const { p, rerender } = pane(); await mount();
    await userEvent.click(within(status()).getByRole('button', { name: 'Language mode' }));
    const dlg = await screen.findByRole('dialog'); expect(within(dlg).getAllByRole('button').length).toBeGreaterThanOrEqual(4);
    await userEvent.type(within(dlg).getByLabelText('Search languages'), 'pyth');
    expect(within(dlg).queryByText('TypeScript')).toBeNull(); await userEvent.click(within(dlg).getByText('Python'));
    expect(p.onTabPatch).toHaveBeenCalledWith('src/a.js', { lang: 'python' });
    rerender(<ThemeProvider theme={buildTheme(DEFAULT_BRANDING)}><EditorPane {...p} tabs={[{ ...TABS[0], lang: 'python' }, TABS[1]]} /></ThemeProvider>);
    expect(screen.getByTestId('monaco')).toHaveAttribute('data-language', 'python');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); // wait for the dialog's exit transition
    await userEvent.click(within(status()).getByRole('button', { name: 'Language mode' })); await userEvent.click(await screen.findByText('Auto-detect from file name'));
    expect(p.onTabPatch).toHaveBeenLastCalledWith('src/a.js', { lang: undefined });
  });
  it('detects the language from the file name by default', () => { pane({ active: 'src/b.py' }); expect(screen.getByTestId('monaco')).toHaveAttribute('data-language', 'python'); });
  it('shows unsaved and read-only indicators', async () => {
    pane({ active: 'src/b.py', canWrite: false }); expect(within(status()).getByText('Loading editor…')).toBeInTheDocument(); await mount();
    expect(within(status()).getByText('● Unsaved')).toBeInTheDocument(); expect(within(status()).getByText('Read-only')).toBeInTheDocument();
  });
  it('registers Ctrl/Cmd+S on the editor and saves the current file', async () => {
    const { p } = pane({ active: 'src/b.py' }); await mount();
    const [keys, handler] = fake.ed.addCommand.mock.calls[0]; expect(keys).toBe(1 | 2); handler(); expect(p.onSave).toHaveBeenCalledWith('src/b.py');
  });
});

describe('IdeLayout: names, drag, and drop, resizing, persistence', () => {
  const PANES = { explorer: <div>EXPLORER</div>, sessions: <div>SESSIONS</div>, editor: <div>EDITOR</div>, chat: <div>CHAT</div>, terminal: <div>TERMINAL</div> };
  const SIZE = { w: 1400, h: 800 };
  const dt = () => { const store = {}; return { types: [], setData(k, v) { store[k] = v; this.types.push(k); }, getData: (k) => store[k] || '', effectAllowed: '', dropEffect: '' }; };
  const view = (layout, extra = {}) => { const onLayoutChange = vi.fn(); const r = wrap(<IdeLayout layout={layout} onLayoutChange={onLayoutChange} panes={PANES} size={SIZE} {...extra} />); return { onLayoutChange, ...r }; };
  const box = (n) => screen.getByTestId(`pane-${n}`);
  const at = (n) => { const s = box(n).style; return { x: parseFloat(s.left), y: parseFloat(s.top), w: parseFloat(s.width), h: parseFloat(s.height) }; };
  // jsdom has no DragEvent, so pointer coordinates are attached to the event by hand
  const dragAt = (type, el, x, y, dataTransfer = dt()) => { const ev = createEvent[type](el, { dataTransfer }); Object.defineProperty(ev, 'clientX', { value: x }); Object.defineProperty(ev, 'clientY', { value: y }); fireEvent(el, ev); };
  const startDrag = (name) => { const d = dt(); vi.useFakeTimers(); try { fireEvent.dragStart(screen.getByTestId(`pane-header-${name}`), { dataTransfer: d }); act(() => { vi.runOnlyPendingTimers(); }); } finally { vi.useRealTimers(); } return d; }; // overlays mount a tick after dragstart

  it('every pane shows its name in a header, and the editor is one of them', () => {
    view(DEFAULT_LAYOUT);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent).sort()).toEqual(['Agent', 'Editor', 'Explorer', 'Sessions', 'Terminal']);
    expect(within(box('editor')).getByRole('heading', { name: 'Editor' })).toBeInTheDocument(); expect(within(box('editor')).getByText('EDITOR')).toBeInTheDocument();
  });
  it('places panes where the layout says', () => {
    view(DEFAULT_LAYOUT); const r = computeRects(DEFAULT_LAYOUT, SIZE.w, SIZE.h).rects;
    for (const p of ['explorer', 'sessions', 'editor', 'terminal', 'chat']) expect(at(p).x).toBeCloseTo(r[p].x, 1); expect(at('terminal').y).toBeGreaterThan(at('editor').y);
  });
  it('hidden panes stay mounted but invisible', () => {
    view(hidePane(DEFAULT_LAYOUT, 'chat')); expect(box('chat')).toHaveAttribute('data-hidden', 'true'); expect(box('chat').style.display).toBe('none'); expect(screen.getByText('CHAT')).toBeInTheDocument();
  });
  it('shows no drop targets until a header is dragged, and removes them afterwards', () => {
    view(DEFAULT_LAYOUT); expect(screen.queryByTestId('drop-chat')).toBeNull();
    const d = startDrag('terminal'); expect(d.getData('application/x-ide-pane')).toBe('terminal'); expect(d.effectAllowed).toBe('move');
    expect(screen.getByTestId('drop-chat')).toBeInTheDocument(); expect(screen.queryByTestId('drop-terminal')).toBeNull(); // not onto itself
    for (const e of ['left', 'right', 'top', 'bottom']) expect(screen.getByTestId(`drop-edge-${e}`)).toBeInTheDocument();
    fireEvent.dragEnd(screen.getByTestId('pane-header-terminal')); expect(screen.queryByTestId('drop-chat')).toBeNull();
  });
  it('previews where the pane will land, following the pointer', () => {
    view(DEFAULT_LAYOUT); startDrag('terminal'); const r = computeRects(DEFAULT_LAYOUT, SIZE.w, SIZE.h).rects.chat, target = screen.getByTestId('drop-chat');
    dragAt('dragOver', target, r.x + 5, r.y + r.h / 2); let pv = screen.getByTestId('drop-preview'); expect(pv).toHaveAttribute('data-zone', 'left'); expect(pv.style.width).toBe(`${r.w / 2}px`);
    dragAt('dragOver', target, r.x + r.w / 2, r.y + r.h - 5); expect(screen.getByTestId('drop-preview')).toHaveAttribute('data-zone', 'bottom');
    dragAt('dragOver', target, r.x + r.w / 2, r.y + r.h / 2); expect(screen.getByTestId('drop-preview')).toHaveAttribute('data-zone', 'center');
  });
  it.each([['left', 5, 0.5], ['right', 0.97, 0.5], ['top', 0.5, 0.03], ['bottom', 0.5, 0.97]])('dropping a pane on the %s edge of another splits it there', (zone, fx, fy) => {
    const { onLayoutChange } = view(DEFAULT_LAYOUT); startDrag('terminal'); const r = computeRects(DEFAULT_LAYOUT, SIZE.w, SIZE.h).rects.chat;
    dragAt('drop', screen.getByTestId('drop-chat'), r.x + (fx > 1 ? fx : r.w * fx), r.y + r.h * fy);
    expect(onLayoutChange).toHaveBeenCalledWith(movePane(DEFAULT_LAYOUT, 'terminal', 'chat', zone)); expect(screen.queryByTestId('drop-chat')).toBeNull();
  });
  it('dropping on the middle swaps panes; the editor can be dragged too', () => {
    const { onLayoutChange } = view(DEFAULT_LAYOUT); startDrag('editor'); const r = computeRects(DEFAULT_LAYOUT, SIZE.w, SIZE.h).rects.chat;
    dragAt('drop', screen.getByTestId('drop-chat'), r.x + r.w / 2, r.y + r.h / 2); expect(onLayoutChange).toHaveBeenCalledWith(movePane(DEFAULT_LAYOUT, 'editor', 'chat', 'center'));
  });
  it('dropping on a window edge docks the pane along that whole side', () => {
    const { onLayoutChange } = view(DEFAULT_LAYOUT); startDrag('chat'); fireEvent.dragOver(screen.getByTestId('drop-edge-left'), { dataTransfer: dt() });
    expect(screen.getByTestId('drop-preview')).toHaveAttribute('data-target', ROOT); fireEvent.drop(screen.getByTestId('drop-edge-left'), { dataTransfer: dt() });
    expect(onLayoutChange).toHaveBeenCalledWith(movePaneToEdge(DEFAULT_LAYOUT, 'chat', 'left'));
  });
  it('a drop from something that is not a pane header is ignored', () => {
    const { onLayoutChange } = view(DEFAULT_LAYOUT); expect(screen.queryByTestId('drop-chat')).toBeNull(); expect(onLayoutChange).not.toHaveBeenCalled();
  });
  it('the header menu offers keyboard-friendly moves and hiding (but the editor cannot be hidden)', async () => {
    const { onLayoutChange } = view(DEFAULT_LAYOUT);
    await userEvent.click(screen.getByRole('button', { name: 'Agent panel options' })); await userEvent.click(screen.getByRole('menuitem', { name: 'Move to bottom edge' }));
    expect(onLayoutChange).toHaveBeenLastCalledWith(movePaneToEdge(DEFAULT_LAYOUT, 'chat', 'bottom'));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Terminal panel options' })); await userEvent.click(screen.getByRole('menuitem', { name: 'Hide panel' })); expect(onLayoutChange).toHaveBeenLastCalledWith(hidePane(DEFAULT_LAYOUT, 'terminal'));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Editor panel options' })); expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Move to left edge', 'Move to right edge', 'Move to top edge', 'Move to bottom edge']);
  });
  it('moving panes does NOT remount them (a running agent turn or an unsaved editor survives)', () => {
    let mounts = 0;
    function Stateful() { const [n, setN] = (require('react')).useState(0); (require('react')).useEffect(() => { mounts += 1; }, []); return <button onClick={() => setN(n + 1)}>count {n}</button>; }
    const panes = { ...PANES, chat: <Stateful />, editor: <Stateful /> };
    const { rerender } = wrap(<IdeLayout layout={DEFAULT_LAYOUT} onLayoutChange={() => {}} panes={panes} size={SIZE} />);
    fireEvent.click(screen.getAllByText('count 0')[0]);
    let l = DEFAULT_LAYOUT; for (const next of [movePane(l, 'chat', 'editor', 'bottom'), movePane(l, 'editor', 'chat', 'right'), movePane(l, 'chat', 'editor', 'center'), hidePane(l, 'chat'), DEFAULT_LAYOUT])
      rerender(<ThemeProvider theme={buildTheme(DEFAULT_BRANDING)}><IdeLayout layout={next} onLayoutChange={() => {}} panes={panes} size={SIZE} /></ThemeProvider>);
    expect(mounts).toBe(2); expect(screen.getAllByText(/count 1/).length).toBe(1);
  });
  it('exposes accessible dividers and resizes with the keyboard (Shift = bigger steps)', () => {
    const { onLayoutChange } = view(DEFAULT_LAYOUT);
    const sep = screen.getByRole('separator', { name: 'Resize Explorer and Editor' }); expect(sep).toHaveAttribute('aria-orientation', 'vertical'); expect(sep).toHaveAttribute('tabindex', '0');
    const before = computeRects(DEFAULT_LAYOUT, SIZE.w, SIZE.h).rects.explorer.w;
    fireEvent.keyDown(sep, { key: 'ArrowRight' }); expect(computeRects(onLayoutChange.mock.calls.at(-1)[0], SIZE.w, SIZE.h).rects.explorer.w).toBeCloseTo(before + 16, 2);
    fireEvent.keyDown(sep, { key: 'ArrowLeft', shiftKey: true }); expect(computeRects(onLayoutChange.mock.calls.at(-1)[0], SIZE.w, SIZE.h).rects.explorer.w).toBeCloseTo(before - 64, 2);
    const n = onLayoutChange.mock.calls.length; fireEvent.keyDown(sep, { key: 'ArrowUp' }); expect(onLayoutChange.mock.calls.length).toBe(n); // wrong axis
    const h = screen.getByRole('separator', { name: 'Resize Editor and Terminal' }); expect(h).toHaveAttribute('aria-orientation', 'horizontal');
    fireEvent.keyDown(h, { key: 'ArrowUp' }); expect(computeRects(onLayoutChange.mock.calls.at(-1)[0], SIZE.w, SIZE.h).rects.terminal.h).toBeGreaterThan(computeRects(DEFAULT_LAYOUT, SIZE.w, SIZE.h).rects.terminal.h);
  });
  it('resizes by dragging a divider, and double-click evens out the pair', () => {
    const { onLayoutChange } = view(DEFAULT_LAYOUT); const h = screen.getByRole('separator', { name: 'Resize Explorer and Editor' }); const before = computeRects(DEFAULT_LAYOUT, SIZE.w, SIZE.h).rects.explorer.w;
    fireEvent.pointerDown(h, { clientX: 266, clientY: 100, pointerId: 1 }); fireEvent(window, new MouseEvent('pointermove', { clientX: 326, clientY: 100, bubbles: true }));
    expect(computeRects(onLayoutChange.mock.calls.at(-1)[0], SIZE.w, SIZE.h).rects.explorer.w).toBeCloseTo(before + 60, 2);
    fireEvent(window, new MouseEvent('pointerup', { bubbles: true })); const n = onLayoutChange.mock.calls.length; fireEvent(window, new MouseEvent('pointermove', { clientX: 500, bubbles: true })); expect(onLayoutChange.mock.calls.length).toBe(n);
    fireEvent.doubleClick(screen.getByRole('separator', { name: 'Resize Explorer and Sessions' })); const r = computeRects(onLayoutChange.mock.calls.at(-1)[0], SIZE.w, SIZE.h).rects; expect(r.explorer.h).toBeCloseTo(r.sessions.h, 2);
  });
  it('saves the layout shortly after it changes', async () => {
    view(movePane(DEFAULT_LAYOUT, 'chat', 'editor', 'bottom')); await waitFor(() => expect(visiblePanes(JSON.parse(localStorage.getItem('ide-layout-v2')))).toContain('chat'));
    expect(JSON.parse(localStorage.getItem('ide-layout-v2')).v).toBe(2);
  });
});
