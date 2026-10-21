import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import FileTree, { DRAG_TYPE } from '../src/components/FileTree.jsx';
import { remap, dirName, joinPath, isWithin } from '../src/components/pathUtils.js';
import { buildTheme, DEFAULT_BRANDING } from '../src/theme.js';
import { renderApp, userWith, ALL } from './helpers.jsx';

vi.mock('@monaco-editor/react', () => ({ default: (p) => <div data-testid="monaco" data-path={p.path} />, DiffEditor: () => <div /> }));
vi.mock('@xterm/xterm', () => ({ Terminal: class { loadAddon() {} open() {} write() {} onData() { return { dispose() {} }; } dispose() {} } }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
const { default: IDE } = await import('../src/pages/IDE.jsx');

const TREE = [
  { name: 'lib', path: 'lib', type: 'dir', children: [] },
  { name: 'src', path: 'src', type: 'dir', children: [{ name: 'deep', path: 'src/deep', type: 'dir', children: [{ name: 'x.js', path: 'src/deep/x.js', type: 'file' }] }, { name: 'a.js', path: 'src/a.js', type: 'file' }] },
  { name: 'README.md', path: 'README.md', type: 'file' },
];
function dt(data = {}, files = []) { const store = { ...data }; return { types: [...Object.keys(store), ...(files.length ? ['Files'] : [])], setData(k, v) { store[k] = v; if (!this.types.includes(k)) this.types.push(k); }, getData: (k) => store[k] || '', files, items: [], effectAllowed: '', dropEffect: '' }; }
const tree = (over = {}) => { const actions = Object.fromEntries(['move', 'moveMany', 'removeMany', 'upload', 'pickUpload', 'newFile', 'newFolder', 'rename', 'remove', 'download'].map((k) => [k, vi.fn()])); const onOpen = vi.fn(); const r = render(<ThemeProvider theme={buildTheme(DEFAULT_BRANDING)}><FileTree tree={TREE} onOpen={onOpen} canWrite canDownload actions={actions} {...over} /></ThemeProvider>); return { actions, onOpen, ...r }; };
const node = (p) => screen.getByTestId(`node-${p}`);
const menu = () => screen.getByRole('menu', { name: 'File actions' });
const labels = () => within(menu()).getAllByRole('menuitem').map((m) => m.textContent.replace(/(F2|Del)$/, ''));

describe('path helpers', () => {
  it('remaps paths under a renamed or moved folder, and only those', () => {
    expect(remap('src/a.js', 'src', 'lib')).toBe('lib/a.js'); expect(remap('src', 'src', 'lib')).toBe('lib'); expect(remap('src/deep/x.js', 'src/deep', 'src/d2')).toBe('src/d2/x.js');
    expect(remap('srcs/a.js', 'src', 'lib')).toBe('srcs/a.js'); expect(remap('other.js', 'src', 'lib')).toBe('other.js');
    expect(dirName('a/b/c.js')).toBe('a/b'); expect(dirName('c.js')).toBe(''); expect(joinPath('', 'x')).toBe('x'); expect(joinPath('a', 'x')).toBe('a/x');
    expect(isWithin('a/b', 'a')).toBe(true); expect(isWithin('ab', 'a')).toBe(false); expect(isWithin('a', 'a')).toBe(true);
  });
});

describe('file tree: context menu and keyboard', () => {
  it('file menu: open, download, rename, delete (+ create/upload in its folder)', async () => {
    const { actions, onOpen } = tree(); await userEvent.click(node('src')); // expand
    fireEvent.contextMenu(await screen.findByTestId('node-src/a.js'));
    expect(labels()).toEqual(['Open', 'New file…', 'New folder…', 'Upload files…', 'Download', 'Rename…', 'Delete']);
    await userEvent.click(within(menu()).getByText('Rename…')); expect(actions.rename).toHaveBeenCalledWith('src/a.js', false);
    fireEvent.contextMenu(node('src/a.js')); await userEvent.click(within(menu()).getByText('New file…')); expect(actions.newFile).toHaveBeenCalledWith('src'); // created beside the file
    fireEvent.contextMenu(node('src/a.js')); await userEvent.click(within(menu()).getByText('Download')); expect(actions.download).toHaveBeenCalledWith('src/a.js', false);
    fireEvent.contextMenu(node('src/a.js')); await userEvent.click(within(menu()).getByText('Delete')); expect(actions.remove).toHaveBeenCalledWith('src/a.js', false);
    fireEvent.contextMenu(node('src/a.js')); await userEvent.click(within(menu()).getByText('Open')); expect(onOpen).toHaveBeenCalledWith('src/a.js');
  });
  it('folder menu: create inside, upload into, download as zip, rename, delete', async () => {
    const { actions } = tree(); fireEvent.contextMenu(node('src'));
    expect(labels()).toEqual(['New file…', 'New folder…', 'Upload files…', 'Download as zip', 'Rename…', 'Delete']);
    await userEvent.click(within(menu()).getByText('New folder…')); expect(actions.newFolder).toHaveBeenCalledWith('src');
    fireEvent.contextMenu(node('src')); await userEvent.click(within(menu()).getByText('Upload files…')); expect(actions.pickUpload).toHaveBeenCalledWith('src');
    fireEvent.contextMenu(node('src')); await userEvent.click(within(menu()).getByText('Download as zip')); expect(actions.download).toHaveBeenCalledWith('src', true);
    fireEvent.contextMenu(node('src')); await userEvent.click(within(menu()).getByText('Delete')); expect(actions.remove).toHaveBeenCalledWith('src', true);
  });
  it('empty-area menu offers new file / folder / upload at the project root', async () => {
    const { actions } = tree(); fireEvent.contextMenu(screen.getByTestId('tree-root'));
    expect(labels()).toEqual(['New file…', 'New folder…', 'Upload files…']); await userEvent.click(within(menu()).getByText('Upload files…')); expect(actions.pickUpload).toHaveBeenCalledWith('');
  });
  it('every row has an accessible actions button that opens the same menu', async () => {
    const { actions } = tree(); await userEvent.click(screen.getByRole('button', { name: 'Actions for README.md' })); await userEvent.click(within(menu()).getByText('Rename…')); expect(actions.rename).toHaveBeenCalledWith('README.md', false);
  });
  it('F2 renames and Delete removes the focused item', () => {
    const { actions } = tree(); fireEvent.keyDown(node('README.md'), { key: 'F2' }); expect(actions.rename).toHaveBeenCalledWith('README.md', false);
    fireEvent.keyDown(node('lib'), { key: 'Delete' }); expect(actions.remove).toHaveBeenCalledWith('lib', true);
  });
  it('read-only users can open and download but not change anything; zip needs download.code', async () => {
    const { actions } = tree({ canWrite: false, canDownload: false }); fireEvent.contextMenu(node('README.md'));
    expect(labels()).toEqual(['Open', 'Download']); fireEvent.keyDown(node('README.md'), { key: 'F2' }); fireEvent.keyDown(node('README.md'), { key: 'Delete' }); expect(actions.rename).not.toHaveBeenCalled(); expect(actions.remove).not.toHaveBeenCalled();
    expect(node('README.md')).not.toHaveAttribute('draggable', 'true'); await userEvent.keyboard('{Escape}');
    fireEvent.contextMenu(node('lib')); expect(within(menu()).getByText('No actions available')).toBeInTheDocument();
  });
});

describe('file tree: drag and drop', () => {
  it('dragging an item onto a folder moves it there, highlighting the target', () => {
    const { actions } = tree(); const d = dt();
    fireEvent.dragStart(node('README.md'), { dataTransfer: d }); expect(d.getData(DRAG_TYPE)).toBe('README.md'); expect(d.effectAllowed).toBe('move');
    fireEvent.dragOver(node('lib'), { dataTransfer: d }); expect(node('lib')).toHaveAttribute('data-dropping', 'true');
    fireEvent.drop(node('lib'), { dataTransfer: d }); expect(actions.move).toHaveBeenCalledWith('README.md', 'lib'); expect(node('lib')).not.toHaveAttribute('data-dropping');
  });
  it('dropping on a file moves into that file\'s folder; dropping on the empty area moves to the root', async () => {
    const { actions } = tree(); await userEvent.click(node('src'));
    let d = dt(); fireEvent.dragStart(node('README.md'), { dataTransfer: d }); fireEvent.drop(await screen.findByTestId('node-src/a.js'), { dataTransfer: d }); expect(actions.move).toHaveBeenLastCalledWith('README.md', 'src');
    d = dt(); fireEvent.dragStart(node('src/a.js'), { dataTransfer: d }); fireEvent.drop(screen.getByTestId('tree-root'), { dataTransfer: d }); expect(actions.move).toHaveBeenLastCalledWith('src/a.js', '');
  });
  it('ignores pointless or impossible moves: same folder, into itself, into a descendant', async () => {
    const { actions } = tree(); await userEvent.click(node('src'));
    let d = dt(); fireEvent.dragStart(await screen.findByTestId('node-src/a.js'), { dataTransfer: d }); fireEvent.drop(node('src'), { dataTransfer: d }); // already in src
    d = dt(); fireEvent.dragStart(node('src'), { dataTransfer: d }); fireEvent.dragOver(node('src'), { dataTransfer: d }); expect(node('src')).not.toHaveAttribute('data-dropping'); fireEvent.drop(node('src'), { dataTransfer: d });
    fireEvent.drop(node('src/deep'), { dataTransfer: d }); // src -> src/deep
    expect(actions.move).not.toHaveBeenCalled();
  });
  it('dropping files from the desktop uploads them into the folder (or the root)', async () => {
    const { actions } = tree(); const f = new File(['hi'], 'photo.png', { type: 'image/png' });
    fireEvent.drop(node('lib'), { dataTransfer: dt({}, [f]) }); await waitFor(() => expect(actions.upload).toHaveBeenCalledTimes(1));
    expect(actions.upload.mock.calls[0][0]).toEqual([{ file: f, rel: 'photo.png' }]); expect(actions.upload.mock.calls[0][1]).toBe('lib');
    fireEvent.drop(screen.getByTestId('tree-root'), { dataTransfer: dt({}, [f]) }); await waitFor(() => expect(actions.upload).toHaveBeenCalledTimes(2)); expect(actions.upload.mock.calls[1][1]).toBe('');
  });
  it('preserves the folder structure of dropped folders', async () => {
    const { actions } = tree(); const f1 = new File(['1'], 'a.txt'), f2 = new File(['2'], 'b.txt');
    const file = (name, f) => ({ isFile: true, name, file: (ok) => ok(f) });
    const dir = (name, kids) => ({ isDirectory: true, name, createReader: () => { let done = false; return { readEntries: (ok) => { const batch = done ? [] : kids; done = true; ok(batch); } }; } });
    const d = dt({}, [f1]); d.items = [{ kind: 'file', webkitGetAsEntry: () => dir('assets', [file('a.txt', f1), dir('more', [file('b.txt', f2)])]) }];
    fireEvent.drop(node('lib'), { dataTransfer: d }); await waitFor(() => expect(actions.upload).toHaveBeenCalled());
    expect(actions.upload.mock.calls[0][0].map((x) => x.rel)).toEqual(['assets/a.txt', 'assets/more/b.txt']);
  });
  it('read-only users cannot drag or drop', () => {
    const { actions } = tree({ canWrite: false }); const d = dt(); fireEvent.dragStart(node('README.md'), { dataTransfer: d }); fireEvent.drop(node('lib'), { dataTransfer: d }); fireEvent.drop(node('lib'), { dataTransfer: dt({}, [new File(['x'], 'x')]) });
    expect(actions.move).not.toHaveBeenCalled(); expect(actions.upload).not.toHaveBeenCalled();
  });
  it('a row keeps its identity while dragging over it (the tree is not remounted)', () => {
    tree(); const el = node('lib'); const d = dt(); fireEvent.dragStart(node('README.md'), { dataTransfer: d }); fireEvent.dragOver(el, { dataTransfer: d }); fireEvent.dragLeave(el, { dataTransfer: d, relatedTarget: document.body });
    expect(node('lib')).toBe(el);
  });
});

// ---------------- the same features wired into the IDE
const sse = (...evs) => new Response(evs.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
let treeData;
const ide = (routes = {}) => renderApp(<IDE />, { user: userWith(ALL), routes: {
  '/api/projects': [{ id: 1, name: 'demo' }], '/api/projects/1/tree': () => treeData, '/api/projects/1/checkpoints': [], '/api/models': { models: [], defaults: {} }, '/api/skills': [], '/api/terminal/status': { enabled: false },
  '/api/projects/1/file': (init) => ({ path: 'x', content: 'content' }), ...routes } });
const calls = (f, m, re) => f.calls.filter((c) => c.method === m && re.test(c.url));
beforeEach(() => { treeData = structuredClone(TREE); localStorage.clear(); vi.restoreAllMocks(); });
const openFile = async (name) => { await userEvent.click(await screen.findByText(name)); await screen.findByRole('button', { name: new RegExp(`Close .*${name}`) }); };
const fileInput = () => screen.getByTestId('upload-input');
const uploadResp = (status, body = {}) => new Response(JSON.stringify(body), { status });

describe('IDE file management', () => {
  it('uploads picked files as raw binary with the CSRF token, then refreshes the tree', async () => {
    const f = new File([new Uint8Array([0, 1, 255])], 'logo.png', { type: 'image/png' });
    const { fetch } = ide({ 'PUT /api/projects/1/upload': () => uploadResp(201, { ok: true }) });
    await screen.findByText('README.md'); await userEvent.upload(fileInput(), f);
    await waitFor(() => expect(calls(fetch, 'PUT', /upload/)).toHaveLength(1)); const c = calls(fetch, 'PUT', /upload/)[0];
    expect(c.url).toBe('/api/projects/1/upload?path=logo.png'); expect(c.body).toBe(f); expect(c.headers['Content-Type']).toBe('application/octet-stream'); expect(c.headers['X-CSRF-Token']).toBe('tok');
    expect(await screen.findByText('Uploaded 1 file')).toBeInTheDocument();
  });
  it('uploads into a folder chosen from its menu', async () => {
    const { fetch } = ide({ 'PUT /api/projects/1/upload': () => uploadResp(201) });
    await screen.findByText('lib'); fireEvent.contextMenu(screen.getByTestId('node-lib')); await userEvent.click(await screen.findByText('Upload files…'));
    await userEvent.upload(fileInput(), new File(['x'], 'a.txt')); await waitFor(() => expect(calls(fetch, 'PUT', /upload/)[0].url).toBe('/api/projects/1/upload?path=lib%2Fa.txt'));
  });
  it('asks before replacing an existing file, and skips it if you say no', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValueOnce(false);
    let n = 0; const { fetch } = ide({ 'PUT /api/projects/1/upload': () => { n += 1; return n === 2 ? uploadResp(201) : uploadResp(409, { error: 'exists' }); } });
    await screen.findByText('README.md'); await userEvent.upload(fileInput(), [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')]);
    await waitFor(() => expect(screen.getByText(/Uploaded 1 file\. 1 skipped/)).toBeInTheDocument());
    expect(confirm).toHaveBeenCalledTimes(2); expect(calls(fetch, 'PUT', /upload/).map((c) => c.url)).toEqual(['/api/projects/1/upload?path=a.txt', '/api/projects/1/upload?path=a.txt&overwrite=1', '/api/projects/1/upload?path=b.txt']);
  });
  it('reports failures per file without stopping the rest', async () => {
    let n = 0; ide({ 'PUT /api/projects/1/upload': () => { n += 1; return n === 1 ? uploadResp(413, { error: 'too_large' }) : uploadResp(201); } });
    await screen.findByText('README.md'); await userEvent.upload(fileInput(), [new File(['a'], 'big.bin'), new File(['b'], 'ok.txt')]);
    expect(await screen.findByText(/Uploaded 1 file\. Failed: big\.bin: it is larger than the upload limit/)).toBeInTheDocument();
  });
  it('uploads files dropped on a folder', async () => {
    const { fetch } = ide({ 'PUT /api/projects/1/upload': () => uploadResp(201) });
    await screen.findByText('lib'); fireEvent.drop(screen.getByTestId('node-lib'), { dataTransfer: dt({}, [new File(['x'], 'dropped.txt')]) });
    await waitFor(() => expect(calls(fetch, 'PUT', /upload/)[0].url).toBe('/api/projects/1/upload?path=lib%2Fdropped.txt'));
  });
  it('renames through a dialog and keeps the open tab pointing at the renamed file', async () => {
    const { fetch } = ide({ 'POST /api/projects/1/rename': { ok: true } });
    await openFile('README.md'); fireEvent.contextMenu(screen.getByTestId('node-README.md')); await userEvent.click(await screen.findByText('Rename…'));
    const box = await screen.findByLabelText('New name'); expect(box).toHaveValue('README.md'); await userEvent.clear(box); await userEvent.type(box, 'GUIDE.md'); await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(calls(fetch, 'POST', /rename/)[0].body).toEqual({ from: 'README.md', to: 'GUIDE.md' }));
    expect(await screen.findByRole('button', { name: 'Close GUIDE.md' })).toBeInTheDocument(); expect(screen.getByTestId('monaco')).toHaveAttribute('data-path', '1/GUIDE.md');
  });
  it('renaming a folder re-points the open files inside it', async () => {
    ide({ 'POST /api/projects/1/rename': { ok: true } });
    await userEvent.click(await screen.findByText('src')); await openFile('a.js');
    fireEvent.contextMenu(screen.getByTestId('node-src')); await userEvent.click(await screen.findByText('Rename…')); const box = await screen.findByLabelText('New name'); await userEvent.clear(box); await userEvent.type(box, 'source{Enter}');
    expect(await screen.findByRole('button', { name: 'Close source/a.js' })).toBeInTheDocument();
  });
  it('refuses a "name" that contains a slash (moving is done by dragging) and unchanged names do nothing', async () => {
    const { fetch } = ide({ 'POST /api/projects/1/rename': { ok: true } });
    await screen.findByText('README.md'); fireEvent.contextMenu(screen.getByTestId('node-README.md')); await userEvent.click(await screen.findByText('Rename…'));
    const box = await screen.findByLabelText('New name'); await userEvent.clear(box); await userEvent.type(box, 'a/b.md{Enter}'); expect(await screen.findByText(/cannot contain "\/"/)).toBeInTheDocument();
    fireEvent.contextMenu(screen.getByTestId('node-README.md')); await userEvent.click(await screen.findByText('Rename…')); await userEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    expect(calls(fetch, 'POST', /rename/)).toHaveLength(0);
  });
  it('moving by drag and drop calls the server, keeps tabs in sync, and explains conflicts', async () => {
    let fail = false; const { fetch } = ide({ 'POST /api/projects/1/rename': () => (fail ? new Response(JSON.stringify({ error: 'exists_directory' }), { status: 409 }) : { ok: true }) });
    await openFile('README.md'); const d = dt(); fireEvent.dragStart(screen.getByTestId('node-README.md'), { dataTransfer: d }); fireEvent.drop(screen.getByTestId('node-lib'), { dataTransfer: d });
    await waitFor(() => expect(calls(fetch, 'POST', /rename/)[0].body).toEqual({ from: 'README.md', to: 'lib/README.md' }));
    expect(await screen.findByRole('button', { name: 'Close lib/README.md' })).toBeInTheDocument();
    fail = true; const d2 = dt(); fireEvent.dragStart(screen.getByTestId('node-lib'), { dataTransfer: d2 }); fireEvent.drop(screen.getByTestId('node-src'), { dataTransfer: d2 });
    expect(await screen.findByText(/Could not move lib: a folder with that name already exists/)).toBeInTheDocument();
  });
  it('asks before replacing a file when a move would overwrite one', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true); let n = 0;
    const { fetch } = ide({ 'POST /api/projects/1/rename': () => { n += 1; return n === 1 ? new Response(JSON.stringify({ error: 'exists' }), { status: 409 }) : { ok: true }; } });
    await screen.findByText('README.md'); const d = dt(); fireEvent.dragStart(screen.getByTestId('node-README.md'), { dataTransfer: d }); fireEvent.drop(screen.getByTestId('node-lib'), { dataTransfer: d });
    await waitFor(() => expect(calls(fetch, 'POST', /rename/)).toHaveLength(2)); expect(confirm).toHaveBeenCalled(); expect(calls(fetch, 'POST', /rename/)[1].body).toEqual({ from: 'README.md', to: 'lib/README.md', overwrite: true });
  });
  it('deletes after confirmation, closing the tabs of deleted files; declining does nothing', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { fetch } = ide({ 'DELETE /api/projects/1/file': { ok: true } });
    await openFile('README.md'); fireEvent.keyDown(screen.getByTestId('node-README.md'), { key: 'Delete' }); expect(calls(fetch, 'DELETE', /file/)).toHaveLength(0);
    fireEvent.keyDown(screen.getByTestId('node-README.md'), { key: 'Delete' }); await waitFor(() => expect(calls(fetch, 'DELETE', /file/)[0].url).toBe('/api/projects/1/file?path=README.md'));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close README.md' })).toBeNull()); expect(confirm.mock.calls[1][0]).toBe('Delete README.md?');
  });
  it('deleting a folder warns that its contents go too and closes tabs inside it', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true); ide({ 'DELETE /api/projects/1/file': { ok: true } });
    await userEvent.click(await screen.findByText('src')); await openFile('a.js'); fireEvent.keyDown(screen.getByTestId('node-src'), { key: 'Delete' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close src/a.js' })).toBeNull()); expect(confirm.mock.calls[0][0]).toBe('Delete the folder src and everything in it?');
  });
  it('downloads a file and a folder zip through the right endpoints', async () => {
    const clicks = []; const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { clicks.push(this.getAttribute('href')); };
    ide(); await screen.findByText('README.md');
    fireEvent.contextMenu(screen.getByTestId('node-README.md')); await userEvent.click(await screen.findByText('Download'));
    fireEvent.contextMenu(screen.getByTestId('node-src')); await userEvent.click(await screen.findByText('Download as zip'));
    expect(clicks).toEqual(['/api/projects/1/download-file?path=README.md', '/api/projects/1/download?path=src']); HTMLAnchorElement.prototype.click = orig;
  });
  it('creates folders and files; a new file never overwrites an existing one', async () => {
    let fileStatus = 201;
    const { fetch } = ide({ 'POST /api/projects/1/mkdir': { ok: true }, 'PUT /api/projects/1/upload': () => uploadResp(fileStatus, fileStatus === 409 ? { error: 'exists' } : {}) });
    await screen.findByText('lib'); fireEvent.contextMenu(screen.getByTestId('node-lib')); await userEvent.click(await screen.findByText('New folder…'));
    await userEvent.type(await screen.findByLabelText(/Folder name/), 'assets{Enter}'); await waitFor(() => expect(calls(fetch, 'POST', /mkdir/)[0].body).toEqual({ path: 'lib/assets' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); // dialog exit transition
    await userEvent.click(await screen.findByRole('button', { name: 'New file' })); await userEvent.type(await screen.findByLabelText(/Name or path/), 'notes.txt{Enter}');
    await waitFor(() => expect(calls(fetch, 'PUT', /upload/)[0].url).toBe('/api/projects/1/upload?path=notes.txt')); expect(calls(fetch, 'PUT', /upload/)[0].url).not.toContain('overwrite');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 4000 });
    fileStatus = 409; await userEvent.click(await screen.findByRole('button', { name: 'New file' })); await userEvent.type(await screen.findByLabelText(/Name or path/), 'README.md{Enter}');
    expect(await screen.findByText(/Could not create README\.md: a file or folder with that name already exists/)).toBeInTheDocument();
  });
  it('a read-only role gets no write controls in the explorer', async () => {
    renderApp(<IDE />, { user: userWith(['project.read', 'files.read', 'agent.plan', 'provider.use']), routes: { '/api/projects': [{ id: 1, name: 'demo' }], '/api/projects/1/tree': TREE, '/api/models': { models: [], defaults: {} }, '/api/skills': [], '/api/terminal/status': { enabled: false } } });
    await screen.findByText('README.md'); for (const n of ['New file', 'New folder', 'Upload files']) expect(screen.queryByRole('button', { name: n })).toBeNull(); expect(screen.getByRole('button', { name: 'Refresh files' })).toBeInTheDocument();
  });
});

describe('file tree: multi-select mode', () => {
  it('checks several items, then deletes / downloads them together; folders cover their children', async () => {
    const { actions, onOpen } = tree(); await userEvent.click(screen.getByRole('button', { name: 'Select' }));
    await userEvent.click(node('README.md')); expect(onOpen).not.toHaveBeenCalled(); // clicking selects instead of opening
    await userEvent.click(node('src')); // checks folder (does not expand)
    expect(screen.getByText('2 selected')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Download' })); expect(actions.download).toHaveBeenCalledWith('README.md', false); expect(actions.download).toHaveBeenCalledWith('src', true);
    await userEvent.click(within(screen.getByTestId('select-bar')).getByRole('button', { name: 'Delete' })); expect(actions.removeMany).toHaveBeenCalledWith(['README.md', 'src']);
  });
});
