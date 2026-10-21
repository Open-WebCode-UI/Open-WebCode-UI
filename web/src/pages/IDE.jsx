import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Select, MenuItem, Button, Stack, IconButton, Alert, Divider, Tooltip, Tabs, Tab, Dialog, DialogTitle, DialogContent, DialogContentText, DialogActions } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DownloadIcon from '@mui/icons-material/Download';
import NoteAddIcon from '@mui/icons-material/NoteAddOutlined';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolderOutlined';
import UploadFileIcon from '@mui/icons-material/UploadFileOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { get, post, put, del, uploadFile } from '../api.js';
import { baseName, dirName, joinPath, isWithin, remap, withPending } from '../components/pathUtils.js';
import { sessions } from '../sessionStore.js';
import { applyLineEdit, LINE_TOOLS } from '../lineEdit.js';
import { useAuth } from '../AuthContext.jsx';
import { useColorMode } from '../colorMode.jsx';
import { resolveMonaco } from '../theme.js';
import FileTree from '../components/FileTree.jsx';
import AgentPanel from '../components/AgentPanel.jsx';
import CheckpointsPanel from '../components/CheckpointsPanel.jsx';
import EditorPane from '../components/ide/EditorPane.jsx';
import { PREVIEW_PREFIX, previewPath, sourceOf } from '../components/ide/markdownPreview.js';
import { isNotebookPath } from '../components/ide/notebook.js';
import IdeLayout from '../components/ide/IdeLayout.jsx';
import TerminalPanel from '../components/ide/TerminalPanel.jsx';
import { PromptDialog, NewProjectDialog, GitDialog } from '../components/ProjectDialogs.jsx';
import { useLayout, layoutStore } from '../layoutStore.js';
import { visiblePanes, showPane } from '../components/ide/layout.js';
import QuickOpen, { flattenFiles } from '../components/ide/QuickOpen.jsx';
import SearchPanel from '../components/ide/SearchPanel.jsx';
import SessionsPanel from '../components/SessionsPanel.jsx';
import StatusPane from '../components/ide/StatusPane.jsx';
import ContactPane from '../components/ide/ContactPane.jsx';

import { useSearchParams } from 'react-router-dom';

const lastProjectId = () => { try { return localStorage.getItem('ideProject'); } catch { return null; } };
const rememberProject = (id) => { try { localStorage.setItem('ideProject', String(id)); } catch { /* storage may be unavailable */ } };

export default function IDE() {
  const { can, config } = useAuth();
  const [params] = useSearchParams(); const wanted = Number(params.get('project')) || undefined; // e.g. a course exercise opens its own workspace
  const [projects, setProjects] = useState([]); const [project, setProject] = useState(null);
  const [tree, setTree] = useState([]); const [tabs, setTabs] = useState([]); const [active, setActive] = useState(null);
  const [side, setSide] = useState('agent'); const [cpKey, setCpKey] = useState(0); const [cpFocus, setCpFocus] = useState(null);
  const [dialog, setDialog] = useState(null); const [note, setNote] = useState('');
  const [shellTick, setShellTick] = useState(0);
  const [view, setView] = useState('files'); const [searchTick, setSearchTick] = useState(0); const [goto, setGoto] = useState(null); const [recent, setRecent] = useState([]);
  const fileInput = useRef(null); const uploadDir = useRef('');
  layoutStore.configure({ shellEnabled: config?.shellEnabled });
  const [layout, setLayout] = useLayout();
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const { mode } = useColorMode();
  const monacoTheme = resolveMonaco(config?.branding?.monacoTheme, mode);

  const loadProjects = useCallback(async (select) => {
    const list = await get('/api/projects').catch(() => []);
    setProjects(list);
    setProject((cur) => (select ? list.find((p) => p.id === select) : cur && list.find((p) => p.id === cur.id)) || list.find((p) => String(p.id) === lastProjectId()) || list[0] || null);
  }, []);
  useEffect(() => { if (project) rememberProject(project.id); }, [project?.id]); // eslint-disable-line
  useEffect(() => { loadProjects(wanted); }, [loadProjects, wanted]);

  const loadTree = useCallback(() => { if (project) get(`/api/projects/${project.id}/tree`).then(setTree).catch(() => setTree([])); else setTree([]); }, [project]);
  useEffect(() => { setTabs([]); setActive(null); loadTree(); }, [project?.id]); // eslint-disable-line

  const open = async (path) => {
    if (!tabsRef.current.find((t) => t.path === path)) {
      try { const f = await get(`/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`); setTabs((t) => [...t, { path, content: f.content, saved: f.content }]); }
      catch (e) { setNote(e.body?.error === 'binary_file' ? 'Binary files cannot be edited here.' : 'Could not open file'); return; }
    }
    setActive(path); setRecent((r) => [path, ...r.filter((p) => p !== path)].slice(0, 20));
  };
  // Opens a rendering of a Markdown file (read-only) or a notebook editor for an .ipynb in its own tab (or switches to it if already open).
  const openPreview = async (path) => {
    const pp = previewPath(path);
    if (!tabsRef.current.find((t) => t.path === pp)) {
      let content = tabsRef.current.find((t) => t.path === path)?.content;
      if (content === undefined) {
        try { content = (await get(`/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`)).content; }
        catch { setNote('Could not open the preview'); return; }
      }
      // A notebook edits the raw JSON tab in place, so that tab is opened alongside it.
      const withSource = isNotebookPath(path) && !tabsRef.current.some((t) => t.path === path);
      setTabs((ts) => {
        const base = withSource && !ts.some((t) => t.path === path) ? [...ts, { path, content, saved: content }] : ts;
        return base.some((t) => t.path === pp) ? base : [...base, { path: pp, source: path, preview: true, content, saved: content }];
      });
    }
    setActive(pp);
  };
  const openMatch = async (path, h) => { await open(path); setGoto({ path, line: h.line, col: h.col, length: h.length, n: Date.now() }); };
  // Search view of the Explorer: shows the Explorer pane if it was hidden, and puts the cursor in the search box.
  const showSearch = () => { setLayout((l) => (visiblePanes(l).includes('explorer') ? l : showPane(l, 'explorer'))); setView('search'); setSearchTick((t) => t + 1); };
  const save = async (path = active) => {
    const t = tabsRef.current.find((x) => x.path === path); if (!t) return false;
    try { await put(`/api/projects/${project.id}/file`, { path, content: t.content }); setTabs((ts) => ts.map((x) => (x.path === path ? { ...x, saved: t.content } : x))); loadTree(); return true; }
    catch (e) { setNote(e.body?.error === 'agent_running' ? 'The agent is running; try again when it finishes.' : 'Save failed'); return false; }
  };
  const saveAll = async () => { for (const t of tabsRef.current.filter((x) => x.content !== x.saved)) await save(t.path); };
  // After agent edits / rollback: refresh the tree and reload clean tabs from disk.
  const refreshFromDisk = useCallback(async () => {
    loadTree();
    for (const t of tabsRef.current) {
      if (t.preview ? tabsRef.current.some((x) => x.path === t.source) : t.content !== t.saved || t.streaming) continue; // a preview follows its open source tab
      const f = await get(`/api/projects/${project.id}/file?path=${encodeURIComponent(sourceOf(t))}`).catch(() => null);
      if (t.preview) { setTabs((ts) => ts.flatMap((x) => (x.path !== t.path ? [x] : f ? [{ ...x, content: f.content, saved: f.content }] : []))); continue; }
      setTabs((ts) => ts.flatMap((x) => (x.path !== t.path ? [x] : f ? [{ ...x, content: f.content, saved: f.content }] : [])));
    }
  }, [project, loadTree]);

  // While the agent is still writing a file, the Explorer lists it (with a spinner) and the Editor fills with what has been written so far.
  // The file only reaches disk when the call completes; then file_changed reloads the real content (and an error puts the old content back).
  const [pending, setPending] = useState([]);
  const live = useRef(new Map()); // tool call id -> { name, path, base?, last? }
  useEffect(() => {
    live.current.clear(); setPending([]);
    if (!project) return undefined;
    const sync = () => setPending([...live.current.values()].filter((s) => s.name === 'write_file').map((s) => s.path));
    const show = (s, content, revealLine) => {
      setTabs((ts) => {
        const t = ts.find((x) => x.path === s.path);
        if (!t) return [...ts, { path: s.path, content, saved: content, streaming: true, revealLine }];
        if (t.content !== t.saved && !t.streaming) return ts; // the user has unsaved edits here: leave them alone
        return ts.map((x) => (x.path === s.path ? { ...x, content, saved: content, streaming: true, revealLine } : x));
      });
      if (!s.focused) { s.focused = true; setActive(s.path); }
    };
    const applyEdit = (s) => {
      const { stream: st, closed } = s.last;
      const op = LINE_TOOLS[s.name];
      if (op) { // line edits: preview the call on the file as it is on disk, re-computed each time more of the call arrives
        const key = op === 'insert' ? 'after_line' : 'start_line';
        if (s.base === undefined || !closed.includes(key) || (op !== 'delete' && !st.content)) return;
        const r = applyLineEdit(s.base, op, { start_line: st.start_line, after_line: st.after_line, end_line: closed.includes('end_line') ? st.end_line : undefined, content: st.content });
        if (!r.error) show(s, r.next, r.from + Math.max(r.added - 1, 0));
        return;
      }
      if (s.base === undefined || !closed.includes('old_string') || !st.new_string || !s.base.includes(st.old_string)) return;
      show(s, s.base.replace(st.old_string, () => st.new_string));
    };
    const onStream = (e) => {
      if (e.project !== project.id || !e.closed?.includes('path') || !e.stream.path) return;
      let s = live.current.get(e.id);
      if (!s) { s = { name: e.name, path: e.stream.path }; live.current.set(e.id, s); sync(); }
      s.last = e;
      if (e.name === 'write_file') { if (e.stream.content !== undefined) show(s, e.stream.content); return; }
      if (s.base === undefined && !s.loading && !s.skip) {
        const t = tabsRef.current.find((x) => x.path === s.path);
        if (t?.content !== undefined && t.content !== t.saved) s.skip = true;
        else if (t && !t.streaming) s.base = t.content;
        else { s.loading = true; get(`/api/projects/${project.id}/file?path=${encodeURIComponent(s.path)}`).then((f) => { s.base = f.content; s.loading = false; applyEdit(s); }).catch(() => { s.skip = true; }); }
      }
      if (!s.skip) applyEdit(s);
    };
    const onEnd = (e) => {
      if (e.project !== project.id) return;
      const s = live.current.get(e.id); if (!s) return;
      live.current.delete(e.id); sync();
      setTabs((ts) => ts.map((x) => (x.path === s.path && x.streaming ? { ...x, streaming: false } : x)));
    };
    const offs = [sessions.on('file_stream', onStream), sessions.on('file_stream_end', onEnd)];
    return () => offs.forEach((f) => f());
  }, [project?.id]); // eslint-disable-line
  const viewTree = useMemo(() => withPending(tree, pending), [tree, pending]);

  // A file named in an agent conclusion opens in the editor when clicked.
  useEffect(() => sessions.on('open_file', (p) => open(p)), [project?.id]); // eslint-disable-line

  // Closing a tab with unsaved changes asks first: save, discard, or keep editing.
  const [closing, setClosing] = useState(null); // { paths, dirty: [paths with unsaved changes] }
  const dropTabs = (paths) => { setTabs((ts) => ts.filter((t) => !paths.includes(t.path))); if (paths.includes(active)) setActive(tabsRef.current.find((t) => !paths.includes(t.path))?.path || null); };
  const requestClose = (paths) => {
    const dirty = tabsRef.current.filter((t) => paths.includes(t.path) && t.content !== t.saved).map((t) => t.path);
    if (dirty.length) setClosing({ paths, dirty }); else dropTabs(paths);
  };
  const close = (path) => requestClose([path]);
  const closeAll = () => requestClose(tabsRef.current.map((t) => t.path));
  const confirmClose = async (saveFirst) => {
    const c = closing; setClosing(null);
    if (saveFirst) for (const p of c.dirty) if (!(await save(p))) return; // a failed save keeps the tab open so nothing is lost
    dropTabs(c.paths);
  };
  const canWrite = can('files.write');
  const canRead = can('files.read');
  // Ctrl/Cmd+P (Go to file) and Ctrl/Cmd+Shift+F (Search in files) work anywhere in the workspace, like VS Code.
  useEffect(() => {
    if (!project || !canRead) return undefined;
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.defaultPrevented) return;
      const k = e.key.toLowerCase();
      if (k === 'p' && !e.shiftKey) { e.preventDefault(); setDialog('quickopen'); }
      else if (k === 'f' && e.shiftKey) { e.preventDefault(); showSearch(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [project?.id, canRead]); // eslint-disable-line

  // ---- file management (explorer context menu, toolbar, drag & drop)
  const why = (e) => ({ exists: 'a file or folder with that name already exists', exists_directory: 'a folder with that name already exists', cannot_move_into_itself: 'a folder cannot be moved into itself', agent_running: 'the agent is running; try again when it finishes', not_found: 'it no longer exists', too_large: 'it is larger than the upload limit', cannot_move_root: 'the project root cannot be moved' }[e.body?.error] || e.body?.error || 'request failed');
  const repath = (from, to) => { setTabs((ts) => ts.map((t) => (t.preview ? { ...t, source: remap(t.source, from, to), path: previewPath(remap(t.source, from, to)) } : { ...t, path: remap(t.path, from, to) }))); setActive((a) => (a ? (a.startsWith(PREVIEW_PREFIX) ? previewPath(remap(a.slice(PREVIEW_PREFIX.length), from, to)) : remap(a, from, to)) : a)); };
  const moveTo = async (from, to, isDir) => {
    const call = (overwrite) => post(`/api/projects/${project.id}/rename`, { from, to, ...(overwrite ? { overwrite: true } : {}) });
    try {
      try { await call(false); } catch (e) { if (e.body?.error === 'exists' && !isDir && window.confirm(`Replace the existing ${to}?`)) await call(true); else throw e; }
      repath(from, to); setNote(`Moved ${from} → ${to}`); loadTree();
    } catch (e) { if (e.body?.error !== 'exists' || isDir) setNote(`Could not move ${baseName(from)}: ${why(e)}`); }
  };
  const nodeIsDir = (p) => { const f = (n) => n.some((x) => (x.path === p ? x.type === 'dir' : x.children ? f(x.children) : false)); return f(tree); };
  const uploadAll = async (items, dir) => {
    if (!project || !items.length) return;
    let ok = 0, skipped = 0; const failed = [];
    for (const { file, rel } of items) {
      const target = joinPath(dir, rel), url = `/api/projects/${project.id}/upload?path=${encodeURIComponent(target)}`;
      try { await uploadFile(url, file); ok += 1; }
      catch (e) {
        if (e.body?.error === 'exists') { if (window.confirm(`Replace the existing ${target}?`)) { try { await uploadFile(`${url}&overwrite=1`, file); ok += 1; } catch (e2) { failed.push(`${rel}: ${why(e2)}`); } } else skipped += 1; }
        else failed.push(`${rel}: ${why(e)}`);
      }
    }
    setNote([ok && `Uploaded ${ok} file${ok === 1 ? '' : 's'}`, skipped && `${skipped} skipped`, failed.length && `Failed: ${failed.join('; ')}`].filter(Boolean).join('. ') || 'Nothing uploaded');
    loadTree(); refreshFromDisk();
  };
  const fileActions = {
    move: (from, toDir) => moveTo(from, joinPath(toDir, baseName(from)), nodeIsDir(from)),
    upload: uploadAll,
    pickUpload: (dir) => { uploadDir.current = dir; fileInput.current?.click(); },
    newFile: (dir) => setDialog({ type: 'file', dir }), newFolder: (dir) => setDialog({ type: 'folder', dir }),
    rename: (path, isDir) => setDialog({ type: 'rename', path, isDir }),
    remove: async (path, isDir) => {
      if (!window.confirm(isDir ? `Delete the folder ${path} and everything in it?` : `Delete ${path}?`)) return;
      try { await del(`/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`); }
      catch (e) { setNote(`Could not delete ${baseName(path)}: ${why(e)}`); return; }
      setTabs((ts) => ts.filter((t) => !isWithin(sourceOf(t), path))); setActive((a) => (a && isWithin(a.startsWith(PREVIEW_PREFIX) ? a.slice(PREVIEW_PREFIX.length) : a, path) ? null : a)); loadTree();
    },
    moveMany: async (paths, toDir) => { for (const from of paths) await moveTo(from, joinPath(toDir, baseName(from)), nodeIsDir(from)); },
    removeMany: async (paths) => {
      if (!paths.length || !window.confirm(`Delete ${paths.length} selected item${paths.length === 1 ? '' : 's'}${paths.some(nodeIsDir) ? ' (folders include everything in them)' : ''}?`)) return;
      const failed = []; let ok = 0;
      for (const path of paths) {
        try { await del(`/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`); ok += 1; setTabs((ts) => ts.filter((t) => !isWithin(sourceOf(t), path))); setActive((a) => (a && isWithin(a.startsWith(PREVIEW_PREFIX) ? a.slice(PREVIEW_PREFIX.length) : a, path) ? null : a)); }
        catch (e) { failed.push(`${baseName(path)}: ${why(e)}`); }
      }
      setNote([ok && `Deleted ${ok} item${ok === 1 ? '' : 's'}`, failed.length && `Failed: ${failed.join('; ')}`].filter(Boolean).join('. ')); loadTree();
    },
    download: (path, isDir) => {
      const a = document.createElement('a'); a.href = `/api/projects/${project.id}/${isDir ? `download?path=${encodeURIComponent(path)}` : `download-file?path=${encodeURIComponent(path)}`}`; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
    },
  };

  const deleteProject = async () => {
    if (!window.confirm(`Delete the project "${project.name}" and all of its files? This cannot be undone.`)) return;
    try { await del(`/api/projects/${project.id}`); } catch (e) { setNote(`Could not delete project: ${why(e)}`); return; }
    setNote(`Deleted project ${project.name}`); setProject(null); loadProjects();
  };
  const onCommand = useCallback((ev) => { setShellTick((t) => t + 1); }, []); // the agent's shell is only created once the first command is approved, so refresh when a command finishes too

  const explorer = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Stack direction="row" spacing={0.5} sx={{ p: 1 }}>
        <Select size="small" fullWidth displayEmpty value={project?.id ?? ''} onChange={(e) => setProject(projects.find((p) => p.id === e.target.value))} inputProps={{ 'aria-label': 'Project' }}>
          {!projects.length && <MenuItem value="">No projects</MenuItem>}
          {projects.map((p) => <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>)}
        </Select>
        {can('project.delete') && project && <Tooltip title="Delete project"><IconButton aria-label="Delete project" onClick={deleteProject}><DeleteOutlineIcon /></IconButton></Tooltip>}
        {can('project.write') && <Tooltip title="New / import project"><IconButton aria-label="New project" onClick={() => setDialog('new')}><AddIcon /></IconButton></Tooltip>}
      </Stack>
      <Stack direction="row" spacing={0.25} sx={{ px: 1, pb: 1 }} alignItems="center" flexWrap="wrap">
        {canWrite && project && <Tooltip title="New file"><IconButton size="small" aria-label="New file" onClick={() => fileActions.newFile('')}><NoteAddIcon fontSize="small" /></IconButton></Tooltip>}
        {canWrite && project && <Tooltip title="New folder"><IconButton size="small" aria-label="New folder" onClick={() => fileActions.newFolder('')}><CreateNewFolderIcon fontSize="small" /></IconButton></Tooltip>}
        {canWrite && project && <Tooltip title="Upload files (or drop them on the tree)"><IconButton size="small" aria-label="Upload files" onClick={() => fileActions.pickUpload('')}><UploadFileIcon fontSize="small" /></IconButton></Tooltip>}
        {project && <Tooltip title="Refresh"><IconButton size="small" aria-label="Refresh files" onClick={loadTree}><RefreshIcon fontSize="small" /></IconButton></Tooltip>}
        {can('download.code') && project && <Tooltip title="Download project as zip"><IconButton size="small" aria-label="Download project zip" component="a" href={`/api/projects/${project.id}/download`}><DownloadIcon fontSize="small" /></IconButton></Tooltip>}
        {can('git.commit') && project && <Button size="small" onClick={() => setDialog('git')}>Git</Button>}
        <input ref={fileInput} type="file" multiple hidden data-testid="upload-input" aria-label="Choose files to upload" onChange={(e) => { const fs = [...e.target.files]; e.target.value = ''; uploadAll(fs.map((file) => ({ file, rel: file.name })), uploadDir.current); }} />
      </Stack>
      <Tabs value={view} onChange={(_, v) => setView(v)} variant="fullWidth" sx={{ minHeight: 30 }}>
        <Tab value="files" label="Files" sx={{ minHeight: 30, py: 0 }} />
        {canRead && <Tab value="search" label="Search" sx={{ minHeight: 30, py: 0 }} />}
      </Tabs>
      <Divider />
      {canRead && <Box sx={{ flexGrow: 1, minHeight: 0, display: view === 'search' ? 'block' : 'none' }}><SearchPanel project={project} focusTick={searchTick} onOpenMatch={openMatch} /></Box>}
      <Box sx={{ overflow: 'auto', flexGrow: 1, display: view === 'search' ? 'none' : 'block' }}>
        <FileTree tree={viewTree} onOpen={open} selected={active} canWrite={canWrite && !!project} canDownload={can('download.code')} canDownloadFiles={can('files.read')} actions={fileActions} />
      </Box>
    </Box>
  );

  const editor = (
    <EditorPane project={project} tabs={tabs} active={active} canWrite={canWrite} defaultTheme={monacoTheme}
      onSelect={setActive} onClose={close} onCloseAll={closeAll}
      onChange={(path, v) => setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, content: v } : t)))} onTabPatch={(path, patch) => setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, ...patch } : t)))}
      onSave={save} onSaveAll={saveAll} onPreview={openPreview} goto={goto} onQuickOpen={() => setDialog('quickopen')} onSearch={showSearch} onNewFile={() => fileActions.newFile('')}
      note={note ? <Alert severity="info" onClose={() => setNote('')} sx={{ borderRadius: 0, py: 0 }}>{note}</Alert> : null} />
  );

  const chat = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Tabs value={side} onChange={(_, v) => setSide(v)} variant="fullWidth" sx={{ minHeight: 34 }}>
        <Tab value="agent" label="Agent" sx={{ minHeight: 34 }} />
        {can('checkpoint.read') && <Tab data-tour="agent-checkpoints" value="checkpoints" label="Checkpoints" sx={{ minHeight: 34 }} />}
      </Tabs>
      <Box sx={{ flexGrow: 1, minHeight: 0 }}>
        <Box sx={{ height: '100%', display: side === 'agent' ? 'block' : 'none' }}><AgentPanel project={project} onFileChanged={refreshFromDisk} onCheckpoint={() => setCpKey((k) => k + 1)} onCommand={onCommand} onOpenCheckpoint={(id) => { if (can('checkpoint.read')) { setCpFocus({ id, n: Date.now() }); setSide('checkpoints'); } }} /></Box>
        {side === 'checkpoints' && <CheckpointsPanel project={project} refreshKey={cpKey} focus={cpFocus} monacoTheme={monacoTheme} onRestored={() => { refreshFromDisk(); sessions.reload(project.id); }} />}
      </Box>
    </Box>
  );

  return (
    <Box sx={{ height: '100%' }}>
      <IdeLayout layout={layout} onLayoutChange={setLayout} panes={{ explorer, sessions: <SessionsPanel project={project} />, editor, chat, terminal: <TerminalPanel project={project} refreshKey={shellTick} />, status: <StatusPane project={project} />, contact: <ContactPane /> }} />
      {closing && (
        <Dialog open onClose={() => setClosing(null)} aria-labelledby="unsaved-title">
          <DialogTitle id="unsaved-title">Unsaved changes</DialogTitle>
          <DialogContent><DialogContentText>{closing.dirty.length === 1 ? `Do you want to save the changes you made to ${baseName(closing.dirty[0])}?` : `Do you want to save the changes you made to these ${closing.dirty.length} files? ${closing.dirty.map(baseName).join(', ')}`} Your changes will be lost if you don't save them.</DialogContentText></DialogContent>
          <DialogActions>
            <Button onClick={() => setClosing(null)}>Cancel</Button>
            <Button color="error" onClick={() => confirmClose(false)}>Don't save</Button>
            <Button variant="contained" autoFocus onClick={() => confirmClose(true)}>Save</Button>
          </DialogActions>
        </Dialog>
      )}
      {dialog === 'quickopen' && <QuickOpen files={flattenFiles(tree)} recent={recent} onOpen={open} onClose={() => setDialog(null)} />}
      {dialog === 'new' && <NewProjectDialog onClose={() => setDialog(null)} onCreated={(id) => { setDialog(null); loadProjects(id); }} />}
      {dialog?.type === 'file' && <PromptDialog title="New file" label={`Name or path${dialog.dir ? ` (in ${dialog.dir}/)` : ''}`} onClose={() => setDialog(null)} onOk={async (v) => {
        const target = joinPath(dialog.dir || '', v); setDialog(null);
        try { await uploadFile(`/api/projects/${project.id}/upload?path=${encodeURIComponent(target)}`, new Blob([])); } // never overwrites an existing file
        catch (e) { setNote(`Could not create ${v}: ${why(e)}`); return; }
        loadTree(); open(target);
      }} />}
      {dialog?.type === 'folder' && <PromptDialog title="New folder" label={`Folder name${dialog.dir ? ` (in ${dialog.dir}/)` : ''}`} onClose={() => setDialog(null)} onOk={async (v) => { const target = joinPath(dialog.dir, v); setDialog(null); await post(`/api/projects/${project.id}/mkdir`, { path: target }).catch((e) => setNote(`Could not create folder: ${why(e)}`)); loadTree(); }} />}
      {dialog?.type === 'rename' && <PromptDialog title={`Rename ${dialog.isDir ? 'folder' : 'file'}`} label="New name" initial={baseName(dialog.path)} okLabel="Rename" onClose={() => setDialog(null)}
        onOk={(v) => { const d = dialog; setDialog(null); if (v.includes('/') || v === '.' || v === '..') { setNote('A name cannot contain "/". Drag the item onto a folder to move it.'); return; } if (v !== baseName(d.path)) moveTo(d.path, joinPath(dirName(d.path), v), d.isDir); }} />}
      {dialog === 'git' && <GitDialog project={project} can={can} onClose={() => setDialog(null)} />}
    </Box>
  );
}
