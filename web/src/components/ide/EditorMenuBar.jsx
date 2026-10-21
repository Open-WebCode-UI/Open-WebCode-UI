import { useRef, useState } from 'react';
import { Box, Button, Divider, ListItemIcon, ListItemText, Menu, MenuItem, Typography } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import { copy, cut, paste, run, baseName, downloadText, mod } from './editorActions.js';
import { MIN_FONT, MAX_FONT } from './editorPrefs.js';

// Menu bar above the editor tabs: File / Edit / View / Go. Edit, View, and Go drive the real Monaco editor. (Workspace layout
// is in the app header, since it is not about the editor.)
export default function EditorMenuBar({ editorRef, project, tab, tabs, canWrite, dirty, prefs, setPrefs, onSave, onSaveAll, onNewFile, onCloseTab, onCloseAll, onSwitchTab, onPreview, onQuickOpen, onSearch, notebook, previewLabel = 'Open Markdown preview' }) {
  const [open, setOpen] = useState(null); // { name, anchor }
  const ed = () => editorRef.current?.editor;
  const hasTab = !!tab && !tab.preview, writable = hasTab && canWrite, M = mod();
  const close = () => setOpen(null);
  // An action runs only after the menu has finished closing. Run straight away, Monaco's own UI (the command palette in particular)
  // opens first and then loses focus when the menu hands focus back to its button, which dismisses it.
  const pending = useRef(null);
  const act = (fn) => () => { pending.current = fn; close(); };
  const afterClose = () => { const fn = pending.current; pending.current = null; if (fn) fn(); };
  const cmd = (id) => act(() => run(ed(), id));
  const M_ = (label, onClick, extra = {}) => ({ label, onClick, ...extra });
  const D = { divider: true };
  const set = (patch) => setPrefs({ ...prefs, ...patch });

  const menus = {
    File: [
      M_('New file…', act(onNewFile), { disabled: !canWrite || !project }),
      M_('Save', act(() => onSave(tab.path)), { shortcut: `${M}S`, disabled: !writable || !dirty }),
      M_('Save all', act(onSaveAll), { disabled: !canWrite || !tabs.some((t) => t.content !== t.saved) }),
      D,
      M_('Download file', act(() => downloadText(baseName(tab.path), tab.content)), { disabled: !hasTab }),
      M_('Download project (.zip)', act(() => { window.location.href = `/api/projects/${project.id}/download`; }), { disabled: !project }),
      D,
      M_('Close tab', act(() => onCloseTab(tab.path)), { shortcut: M === '⌘' ? '⌥W' : 'Alt+W', disabled: !tab }),
      M_('Close all tabs', act(onCloseAll), { disabled: !tabs.length }),
    ],
    Edit: [
      M_('Undo', cmd('undo'), { shortcut: `${M}Z`, disabled: !writable }),
      M_('Redo', cmd('redo'), { shortcut: isMacShift(M), disabled: !writable }),
      D,
      M_('Cut', act(() => cut(ed())), { shortcut: `${M}X`, disabled: !writable }),
      M_('Copy', act(() => copy(ed())), { shortcut: `${M}C`, disabled: !hasTab }),
      M_('Paste', act(() => paste(ed())), { shortcut: `${M}V`, disabled: !writable }),
      D,
      M_('Find', cmd('actions.find'), { shortcut: `${M}F`, disabled: !hasTab }),
      M_('Replace', cmd('editor.action.startFindReplace'), { shortcut: `${M}H`, disabled: !writable }),
      D,
      M_('Select all', cmd('editor.action.selectAll'), { shortcut: `${M}A`, disabled: !hasTab }),
      M_('Toggle line comment', cmd('editor.action.commentLine'), { shortcut: `${M}/`, disabled: !writable }),
      M_('Format document', cmd('editor.action.formatDocument'), { shortcut: 'Shift+Alt+F', disabled: !writable }),
    ],
    View: [
      M_(previewLabel, act(onPreview), { shortcut: `${M === '⌘' ? '⇧⌘' : 'Ctrl+Shift+'}V`, disabled: !onPreview }),
      D,
      M_('Command palette…', cmd('editor.action.quickCommand'), { shortcut: 'F1', disabled: !hasTab }),
      D,
      M_('Word wrap', act(() => set({ wordWrap: !prefs.wordWrap })), { shortcut: M === '⌘' ? '⌥Z' : 'Alt+Z', checked: prefs.wordWrap }),
      M_('Minimap', act(() => set({ minimap: !prefs.minimap })), { checked: prefs.minimap }),
      M_('Show whitespace', act(() => set({ whitespace: !prefs.whitespace })), { checked: prefs.whitespace }),
      M_('Line numbers', act(() => set({ lineNumbers: !prefs.lineNumbers })), { checked: prefs.lineNumbers }),
      D,
      M_('Zoom in', act(() => set({ fontSize: Math.min(MAX_FONT, prefs.fontSize + 1) })), { disabled: prefs.fontSize >= MAX_FONT }),
      M_('Zoom out', act(() => set({ fontSize: Math.max(MIN_FONT, prefs.fontSize - 1) })), { disabled: prefs.fontSize <= MIN_FONT }),
      M_('Reset zoom', act(() => set({ fontSize: 13 }))),
      D,
      M_('Editor theme: app default', act(() => set({ theme: '' })), { checked: prefs.theme === '' }),
      M_('Editor theme: light', act(() => set({ theme: 'vs' })), { checked: prefs.theme === 'vs' }),
      M_('Editor theme: dark', act(() => set({ theme: 'vs-dark' })), { checked: prefs.theme === 'vs-dark' }),
      M_('Editor theme: high contrast', act(() => set({ theme: 'hc-black' })), { checked: prefs.theme === 'hc-black' }),
      D,
      M_('Fold all', cmd('editor.foldAll'), { disabled: !hasTab }),
      M_('Unfold all', cmd('editor.unfoldAll'), { disabled: !hasTab }),
    ],
    ...(notebook ? { Notebook: [
      ...(notebook.canRun ? [
        notebook.all ? M_('Stop', act(notebook.stop)) : M_('Run all', act(notebook.runAll), { disabled: !notebook.editable || notebook.busy || !notebook.hasCode }),
        M_('Restart kernel', act(notebook.restart), { disabled: !notebook.editable || notebook.busy }),
        D,
      ] : []),
      M_('Save', act(notebook.save), { shortcut: `${M}S`, disabled: !notebook.editable || !notebook.dirty }),
    ] } : {}),
    Go: [
      M_('Go to file…', act(onQuickOpen), { shortcut: `${M}P`, disabled: !project }),
      M_('Search in files', act(onSearch), { shortcut: M === '⌘' ? '⇧⌘F' : 'Ctrl+Shift+F', disabled: !project }),
      D,
      M_('Go to line…', cmd('editor.action.gotoLine'), { shortcut: 'Ctrl+G', disabled: !hasTab }),
      M_('Go to symbol in editor…', cmd('editor.action.quickOutline'), { shortcut: M === '⌘' ? '⇧⌘O' : 'Ctrl+Shift+O', disabled: !hasTab }),
      D,
      M_('Go to definition', cmd('editor.action.revealDefinition'), { shortcut: 'F12', disabled: !hasTab }),
      M_('Go to declaration', cmd('editor.action.revealDeclaration'), { disabled: !hasTab }),
      M_('Go to type definition', cmd('editor.action.goToTypeDefinition'), { disabled: !hasTab }),
      M_('Go to implementations', cmd('editor.action.goToImplementation'), { shortcut: `${M}F12`, disabled: !hasTab }),
      M_('Go to references', cmd('editor.action.goToReferences'), { shortcut: 'Shift+F12', disabled: !hasTab }),
      D,
      M_('Go to bracket', cmd('editor.action.jumpToBracket'), { shortcut: M === '⌘' ? '⇧⌘\\' : 'Ctrl+Shift+\\', disabled: !hasTab }),
      M_('Next problem', cmd('editor.action.marker.next'), { shortcut: 'F8', disabled: !hasTab }),
      M_('Previous problem', cmd('editor.action.marker.prev'), { shortcut: 'Shift+F8', disabled: !hasTab }),
      D,
      M_('Next tab', act(() => onSwitchTab(1)), { disabled: tabs.length < 2 }),
      M_('Previous tab', act(() => onSwitchTab(-1)), { disabled: tabs.length < 2 }),
    ],
  };

  return (
    <Box component="nav" aria-label="Editor menu" sx={{ display: 'flex', alignItems: 'center', px: 0.5, minHeight: 30, borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
      {Object.keys(menus).map((name) => (
        <Button key={name} size="small" color="inherit" sx={{ textTransform: 'none', minWidth: 0, px: 1, fontWeight: open?.name === name ? 700 : 400 }}
          aria-haspopup="menu" aria-expanded={open?.name === name} onClick={(e) => setOpen({ name, anchor: e.currentTarget })}
          onMouseEnter={(e) => open && open.name !== name && setOpen({ name, anchor: e.currentTarget })}>{name}</Button>
      ))}
      <Menu anchorEl={open?.anchor} open={!!open} onClose={close} disableRestoreFocus slotProps={{ paper: { sx: { minWidth: 230 } }, transition: { onExited: afterClose } }} MenuListProps={{ dense: true, 'aria-label': open?.name }}>
        {open && menus[open.name].map((it, i) => (it.divider ? <Divider key={i} /> : (
          <MenuItem key={it.label} disabled={it.disabled} onClick={it.onClick} role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={it.checked}>
            {it.checked !== undefined && <ListItemIcon sx={{ minWidth: 28 }}>{it.checked ? <CheckIcon fontSize="small" /> : null}</ListItemIcon>}
            <ListItemText>{it.label}</ListItemText>
            {it.shortcut && <Typography variant="caption" color="text.secondary" sx={{ ml: 3 }}>{it.shortcut}</Typography>}
          </MenuItem>)))}
      </Menu>
    </Box>
  );
}
const isMacShift = (M) => (M === '⌘' ? '⌘⇧Z' : 'Ctrl+Y');
