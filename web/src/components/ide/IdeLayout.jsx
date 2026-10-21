import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, IconButton, ListItemText, Menu, MenuItem, Divider, Stack, Typography } from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import { computeRects, dragHandle, equalizeHandle, movePane, movePaneToEdge, hidePane, zoneAt, previewRect, saveLayout, PANES, PANE_TITLES, HIDEABLE, ROOT } from './layout.js';

const DRAG_TYPE = 'application/x-ide-pane';
const EDGE_ZONES = ['left', 'right', 'top', 'bottom'];

// Header shared by every pane (the editor included): a name, a drag handle, and an options menu. The menu is the
// keyboard-friendly way to do what dragging does.
function PaneFrame({ name, onMoveEdge, onHide, onDragStart, onDragEnd, children }) {
  const [anchor, setAnchor] = useState(null);
  const title = PANE_TITLES[name];
  return (
    <Box data-tour={`pane-${name}`} sx={{ display: 'flex', flexDirection: 'column', height: '100%', bgcolor: 'background.default', overflow: 'hidden' }}>
      <Stack direction="row" alignItems="center" spacing={0.5} draggable onDragStart={onDragStart} onDragEnd={onDragEnd} title={`Drag to rearrange the ${title} panel`} data-testid={`pane-header-${name}`}
        sx={{ height: 32, px: 0.5, borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper', flexShrink: 0, cursor: 'grab', userSelect: 'none' }}>
        <DragIndicatorIcon fontSize="inherit" sx={{ opacity: 0.5, alignSelf: 'center', display: 'block' }} aria-hidden />
        <Typography variant="caption" component="h2" sx={{ flexGrow: 1, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, m: 0, pt: 0.75 }}>{title}</Typography>
        <IconButton size="small" aria-label={`${title} panel options`} aria-haspopup="menu" onClick={(e) => setAnchor(e.currentTarget)} sx={{ p: 0.25 }}><MoreVertIcon fontSize="inherit" /></IconButton>
      </Stack>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} slotProps={{ list: { dense: true, 'aria-label': `${title} panel` } }}>
        {EDGE_ZONES.map((e) => <MenuItem key={e} onClick={() => { setAnchor(null); onMoveEdge(e); }}><ListItemText>Move to {e} edge</ListItemText></MenuItem>)}
        {HIDEABLE.includes(name) && <Divider />}
        {HIDEABLE.includes(name) && <MenuItem onClick={() => { setAnchor(null); onHide(); }}><ListItemText>Hide panel</ListItemText></MenuItem>}
      </Menu>
      <Box sx={{ flexGrow: 1, minHeight: 0, minWidth: 0 }}>{children}</Box>
    </Box>
  );
}

// Places every pane. All panes stay mounted at a fixed place in the tree; only their rectangles change, so moving or
// resizing a pane never resets it (an agent turn that is streaming keeps streaming).
export default function IdeLayout({ layout, onLayoutChange, panes, size }) {
  const root = useRef(null);
  const [measured, setMeasured] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState(null);     // name of the pane being dragged
  const [hover, setHover] = useState(null);   // { target, zone } the pointer is over
  const dims = size || measured;
  useLayoutEffect(() => {
    if (size || !root.current) return undefined;
    const read = () => setMeasured({ w: root.current.clientWidth, h: root.current.clientHeight });
    read();
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', read); return () => window.removeEventListener('resize', read); }
    const ro = new ResizeObserver(read); ro.observe(root.current); return () => ro.disconnect();
  }, [size]);

  const { rects, handles } = computeRects(layout, dims.w, dims.h);
  const layoutRef = useRef(layout); layoutRef.current = layout;
  useEffect(() => { const t = setTimeout(() => saveLayout(layout), 250); return () => clearTimeout(t); }, [layout]); // persist once dragging settles

  // ---- resizing (pointer drag, arrow keys, double-click to equalize)
  const dragRef = useRef(null);
  const fresh = (id) => computeRects(layoutRef.current, dims.w, dims.h).handles.find((h) => h.id === id);
  const startResize = (e, h) => {
    e.preventDefault();
    dragRef.current = { h, x: e.clientX, y: e.clientY, layout: layoutRef.current };
    const move = (ev) => { const d = dragRef.current; if (d) onLayoutChange(dragHandle(d.layout, d.h, d.h.orientation === 'vertical' ? ev.clientX - d.x : ev.clientY - d.y)); };
    const up = () => { dragRef.current = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    document.body.style.cursor = h.orientation === 'vertical' ? 'col-resize' : 'row-resize';
  };
  const keyResize = (e, h) => {
    const k = { ArrowLeft: [-1, 'vertical'], ArrowRight: [1, 'vertical'], ArrowUp: [-1, 'horizontal'], ArrowDown: [1, 'horizontal'] }[e.key];
    if (!k || k[1] !== h.orientation) return;
    e.preventDefault(); onLayoutChange(dragHandle(layoutRef.current, fresh(h.id), k[0] * (e.shiftKey ? 64 : 16)));
  };

  // ---- moving panes by dragging their headers
  const rootOffset = () => { const r = root.current?.getBoundingClientRect(); return { x: r?.left || 0, y: r?.top || 0 }; };
  const dragTimer = useRef(null);
  const startPaneDrag = (name) => (e) => { e.dataTransfer.setData(DRAG_TYPE, name); e.dataTransfer.effectAllowed = 'move'; dragTimer.current = setTimeout(() => setDrag(name), 0); }; // after the browser has captured the drag: the drop overlays appear under the pointer and would cancel it
  const endPaneDrag = () => { clearTimeout(dragTimer.current); setDrag(null); setHover(null); };
  const overTarget = (target, rect) => (e) => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    const o = rootOffset(), zone = target === ROOT ? rect : zoneAt(rect, e.clientX - o.x, e.clientY - o.y);
    setHover((h) => (h?.target === target && h.zone === zone ? h : { target, zone }));
  };
  const dropOn = (target, rect) => (e) => {
    e.preventDefault();
    const name = e.dataTransfer.getData(DRAG_TYPE) || drag, o = rootOffset();
    const zone = target === ROOT ? rect : zoneAt(rect, e.clientX - o.x, e.clientY - o.y);
    endPaneDrag(); if (name) onLayoutChange(movePane(layoutRef.current, name, target, zone));
  };

  const abs = (r) => (r ? { position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h } : { display: 'none' }); // inline: changes on every pixel of a drag
  const preview = hover && (hover.target === ROOT ? rootEdgeRect(hover.zone, dims) : previewRect(rects[hover.target], hover.zone));
  return (
    <Box ref={root} sx={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }} data-testid="ide-layout">
      {PANES.map((p) => (
        <Box key={p} style={abs(rects[p])} data-testid={`pane-${p}`} data-hidden={rects[p] ? undefined : 'true'}>
          <PaneFrame name={p} onDragStart={startPaneDrag(p)} onDragEnd={endPaneDrag} onMoveEdge={(edge) => onLayoutChange(movePaneToEdge(layoutRef.current, p, edge))} onHide={() => onLayoutChange(hidePane(layoutRef.current, p))}>{panes[p]}</PaneFrame>
        </Box>))}
      {handles.map((h) => (
        <Box key={h.id} role="separator" tabIndex={0} aria-orientation={h.orientation} aria-label={h.label} data-testid={`handle-${h.id}`}
          aria-valuenow={Math.round(h.sizes[h.index])} onPointerDown={(e) => startResize(e, h)} onKeyDown={(e) => keyResize(e, h)} onDoubleClick={() => onLayoutChange(equalizeHandle(layoutRef.current, h))}
          style={abs(h.rect)} sx={{ cursor: h.orientation === 'vertical' ? 'col-resize' : 'row-resize', bgcolor: 'divider', zIndex: 2, touchAction: 'none', '&:hover, &:focus-visible, &:active': { bgcolor: 'primary.main' }, outline: 'none' }} />))}
      {drag && (
        <>
          {PANES.filter((p) => rects[p] && p !== drag).map((p) => <Box key={p} data-testid={`drop-${p}`} style={abs(rects[p])} sx={{ zIndex: 10 }} onDragOver={overTarget(p, rects[p])} onDrop={dropOn(p, rects[p])} />)}
          {EDGE_ZONES.map((z) => <Box key={z} data-testid={`drop-edge-${z}`} aria-label={`Dock at the ${z} edge`} style={abs(rootEdgeRect(z, dims, 18))} sx={{ zIndex: 11, bgcolor: 'primary.main', opacity: hover?.target === ROOT && hover.zone === z ? 0.5 : 0.15 }} onDragOver={overTarget(ROOT, z)} onDrop={dropOn(ROOT, z)} />)}
          {preview && <Box data-testid="drop-preview" data-target={hover.target} data-zone={hover.zone} style={abs(preview)} sx={{ zIndex: 12, pointerEvents: 'none', bgcolor: 'primary.main', opacity: 0.28, border: 2, borderColor: 'primary.main', borderRadius: 1 }} />}
        </>
      )}
    </Box>
  );
}
// A thin strip along one window edge (the drop target) or the half-window it would claim (the preview).
function rootEdgeRect(zone, { w, h }, thick) {
  const t = thick ?? (zone === 'left' || zone === 'right' ? w * 0.25 : h * 0.3);
  return { left: { x: 0, y: 0, w: t, h }, right: { x: w - t, y: 0, w: t, h }, top: { x: 0, y: 0, w, h: t }, bottom: { x: 0, y: h - t, w, h: t } }[zone];
}
