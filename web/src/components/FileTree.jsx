import { Fragment, useRef, useState } from 'react';
import { Box, Button, Checkbox, Stack, IconButton, List, ListItemButton, ListItemIcon, ListItemText, Collapse, Menu, MenuItem, Divider, Typography } from '@mui/material';
import FolderIcon from '@mui/icons-material/Folder';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFileOutlined';
import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import CircularProgress from '@mui/material/CircularProgress';
import { baseName, dirName, joinPath, isWithin, filesFromDrop } from './pathUtils.js';

const DRAG_TYPE = 'application/x-ide-path';
const hasFiles = (dt) => [...(dt?.types || [])].includes('Files');
const hasInternal = (dt) => [...(dt?.types || [])].includes(DRAG_TYPE);

// File explorer: open, drag & drop moves, uploads (also by dropping from the desktop), rename, delete, and download.
// All mutations are delegated to `actions`, which the IDE implements against the server.
export default function FileTree({ tree, selected, onOpen, canWrite, canDownload, canDownloadFiles = true, actions = {} }) {
  const [menu, setMenu] = useState(null);      // { x, y, node|null }
  const [dropDir, setDropDir] = useState(null); // folder path ('' = root) currently under a drag
  const [open, setOpen] = useState({});
  const dragging = useRef(null);
  const [selMode, setSelMode] = useState(false);
  const [sel, setSel] = useState([]); // checked paths in select mode
  const toggleSel = (p) => setSel((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]));
  const exitSel = () => { setSelMode(false); setSel([]); };
  // A checked folder already covers everything under it, so drop descendants of other checked paths.
  const picked = sel.filter((p) => !sel.some((q) => q !== p && isWithin(p, q)));
  const kindOf = (p) => { const f = (n) => { for (const x of n) { if (x.path === p) return x.type; const r = x.children && f(x.children); if (r) return r; } return null; }; return f(tree || []); };
  const allPaths = () => { const out = []; const f = (n) => n.forEach((x) => { out.push(x.path); if (x.children) f(x.children); }); f(tree || []); return out; };
  const toggle = (p) => setOpen((o) => ({ ...o, [p]: !(o[p] ?? false) }));

  // ---- drag & drop
  // `from` is the dragged path (internal drags only). Never move into the folder it already lives in, or into itself/a descendant.
  const canMove = (dir, from) => !!from && dirName(from) !== dir && !isWithin(dir, from);
  const dragSet = (from) => (selMode && picked.includes(from) ? picked : [from]);
  const canDropOn = (dir, dt) => canWrite && ((hasInternal(dt) && canMove(dir, dragging.current)) || hasFiles(dt));
  const over = (e, dir) => { if (!canDropOn(dir, e.dataTransfer)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = hasInternal(e.dataTransfer) ? 'move' : 'copy'; setDropDir(dir); };
  const leave = (e, dir) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropDir((d) => (d === dir ? null : d)); };
  const drop = async (e, dir) => {
    e.preventDefault(); e.stopPropagation(); setDropDir(null);
    const dt = e.dataTransfer;
    if (hasInternal(dt)) { const from = dt.getData(DRAG_TYPE) || dragging.current; dragging.current = null; if (canWrite && canMove(dir, from)) { const set = dragSet(from).filter((f) => canMove(dir, f)); if (set.length > 1) actions.moveMany?.(set, dir); else actions.move?.(from, dir); } return; }
    if (hasFiles(dt) && canWrite) { const files = await filesFromDrop(dt); if (files.length) actions.upload?.(files, dir); }
  };
  const dragProps = (node) => (canWrite && !node.pending && (!selMode || sel.includes(node.path)) ? { draggable: true, onDragStart: (e) => { dragging.current = node.path; e.dataTransfer.setData(DRAG_TYPE, node.path); e.dataTransfer.effectAllowed = 'move'; }, onDragEnd: () => { dragging.current = null; setDropDir(null); } } : {});

  // ---- context menu
  const openMenu = (e, node) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, node }); };
  const close = () => setMenu(null);
  const run = (fn) => () => { close(); fn(); };
  const items = (node) => {
    const dir = node ? (node.type === 'dir' ? node.path : dirName(node.path)) : '';
    const out = [];
    if (node?.pending) return out; // still being written by the agent
    if (node?.type === 'file') out.push({ label: 'Open', fn: () => onOpen(node.path) });
    if (canWrite) out.push({ label: 'New file…', fn: () => actions.newFile?.(dir) }, { label: 'New folder…', fn: () => actions.newFolder?.(dir) }, { label: 'Upload files…', fn: () => actions.pickUpload?.(dir) });
    if (node && (node.type === 'dir' ? canDownload : canDownloadFiles)) out.push({ divider: true }, { label: node.type === 'dir' ? 'Download as zip' : 'Download', fn: () => actions.download?.(node.path, node.type === 'dir') });
    if (node && canWrite) out.push({ divider: true }, { label: 'Rename…', hint: 'F2', fn: () => actions.rename?.(node.path, node.type === 'dir') }, { label: 'Delete', hint: 'Del', fn: () => actions.remove?.(node.path, node.type === 'dir') });
    return out;
  };
  const key = (e, node) => {
    if (e.key === 'F2' && canWrite) { e.preventDefault(); actions.rename?.(node.path, node.type === 'dir'); }
    else if (e.key === 'Delete' && canWrite) { e.preventDefault(); actions.remove?.(node.path, node.type === 'dir'); }
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { const r = e.currentTarget.getBoundingClientRect(); openMenu({ preventDefault() {}, stopPropagation() {}, clientX: r.left + 20, clientY: r.bottom }, node); }
  };

  // A plain render function (not a component defined here): a component type created inside render would remount every row
  // on each state change and drop an in-progress drag.
  const renderRow = (node, depth) => {
    const pad = 1 + depth * 1.5, isDir = node.type === 'dir', isOpen = open[node.path] ?? depth < 1;
    return (
      <Fragment key={node.path}>
        <ListItemButton dense selected={selMode ? sel.includes(node.path) : !isDir && selected === node.path} sx={{ pl: pad + (isDir ? 0 : 1.5), outline: isDir && dropDir === node.path ? '2px dashed' : 'none', outlineColor: 'primary.main', outlineOffset: -2, bgcolor: isDir && dropDir === node.path ? 'action.selected' : undefined, '&:hover .row-menu, &:focus-within .row-menu': { opacity: 1 } }}
          data-testid={`node-${node.path}`} data-dropping={isDir && dropDir === node.path ? 'true' : undefined} {...dragProps(node)}
          onClick={() => (selMode ? toggleSel(node.path) : isDir ? toggle(node.path) : onOpen(node.path))} onContextMenu={(e) => openMenu(e, node)} onKeyDown={(e) => key(e, node)}
          {...(isDir ? { onDragOver: (e) => over(e, node.path), onDragLeave: (e) => leave(e, node.path), onDrop: (e) => drop(e, node.path) } : { onDragOver: (e) => over(e, dirName(node.path)), onDrop: (e) => drop(e, dirName(node.path)) })}>
          {selMode && <Checkbox size="small" edge="start" tabIndex={-1} disableRipple checked={sel.includes(node.path)} slotProps={{ input: { 'aria-label': `Select ${node.name}` } }} sx={{ p: 0.5, mr: 0.5 }} />}
          <ListItemIcon sx={{ minWidth: 28 }}>{isDir ? <FolderIcon fontSize="small" /> : <InsertDriveFileIcon fontSize="small" />}</ListItemIcon>
          <ListItemText primary={node.name} primaryTypographyProps={{ variant: 'body2', noWrap: true, ...(node.pending ? { fontStyle: 'italic', color: 'text.secondary' } : {}) }} />
          {node.pending && !isDir && <CircularProgress size={12} aria-label={`Writing ${node.name}`} sx={{ mr: 0.5 }} />}
          <IconButton className="row-menu" size="small" aria-label={`Actions for ${node.name}`} aria-haspopup="menu" sx={{ opacity: 0, '&:focus-visible': { opacity: 1 } }}
            onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); openMenu({ preventDefault() {}, stopPropagation() {}, clientX: r.left, clientY: r.bottom }, node); }}><MoreVertIcon fontSize="inherit" /></IconButton>
          {isDir && (isOpen ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />)}
        </ListItemButton>
        {isDir && <Collapse in={isOpen} unmountOnExit>{node.children.map((c) => renderRow(c, depth + 1))}</Collapse>}
      </Fragment>
    );
  };

  const downloadable = picked.filter((p) => (kindOf(p) === 'dir' ? canDownload : canDownloadFiles));
  const bar = selMode && (
    <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" sx={{ px: 1, py: 0.5, position: 'sticky', top: 0, zIndex: 1, bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }} data-testid="select-bar">
      <Typography variant="caption" sx={{ flexGrow: 1 }} aria-live="polite">{picked.length} selected</Typography>
      <Button size="small" onClick={() => setSel(sel.length === allPaths().length ? [] : allPaths())}>{sel.length && sel.length === allPaths().length ? 'None' : 'All'}</Button>
      {downloadable.length > 0 && <Button size="small" onClick={() => downloadable.forEach((p) => actions.download?.(p, kindOf(p) === 'dir'))}>Download</Button>}
      {canWrite && <Button size="small" color="error" disabled={!picked.length} onClick={async () => { await actions.removeMany?.(picked); setSel([]); }}>Delete</Button>}
      <Button size="small" onClick={exitSel}>Done</Button>
    </Stack>
  );

  return (
    <Box sx={{ minHeight: '100%', outline: dropDir === '' ? '2px dashed' : 'none', outlineColor: 'primary.main', outlineOffset: -2 }} data-testid="tree-root" data-dropping={dropDir === '' ? 'true' : undefined}
      onContextMenu={(e) => openMenu(e, null)} onDragOver={(e) => over(e, '')} onDragLeave={(e) => leave(e, '')} onDrop={(e) => drop(e, '')}>
      {tree?.length > 0 && !selMode && <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: 1 }}><Button size="small" onClick={() => setSelMode(true)}>Select</Button></Box>}
      {bar}
      {tree?.length ? <List dense disablePadding aria-label="Project files">{tree.map((n) => renderRow(n, 0))}</List>
        : <Box sx={{ p: 2, color: 'text.secondary', fontSize: 14 }}>No files yet. {canWrite ? 'Drop files here, right-click for options, or ask the agent to create some.' : 'Ask the agent to create some.'}</Box>}
      <Menu open={!!menu} onClose={close} anchorReference="anchorPosition" anchorPosition={menu ? { top: menu.y, left: menu.x } : undefined} slotProps={{ list: { dense: true, 'aria-label': 'File actions' } }}>
        {menu && (items(menu.node).length ? items(menu.node).map((it, i) => (it.divider ? <Divider key={i} /> : <MenuItem key={it.label} onClick={run(it.fn)}>{it.label}{it.hint && <Typography variant="caption" color="text.secondary" sx={{ ml: 3 }}>{it.hint}</Typography>}</MenuItem>)) : [<MenuItem key="n" disabled>No actions available</MenuItem>])}
      </Menu>
    </Box>
  );
}
export { DRAG_TYPE, joinPath, baseName };
