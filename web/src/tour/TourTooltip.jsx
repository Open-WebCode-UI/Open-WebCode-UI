import { useRef } from 'react';
import { Paper, Typography, Box } from '@mui/material';
import { useFloating, autoUpdate, offset, flip, shift, arrow, size } from '@floating-ui/react-dom';
import TourController from './TourController.jsx';

const ARROW = 10;
const OPPOSITE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

// Positioned by Floating UI against `target`. flip() moves it to the opposite side when it would overflow,
// shift() slides it along the edge, and size() caps its width/height to the room left in the viewport.
// With no target it is simply centered (used for steps whose element is missing or lives on another page).
export default function TourTooltip({ target, step, title, body, controller = <TourController /> }) {
  const arrowRef = useRef(null);
  const { refs, floatingStyles, placement, middlewareData } = useFloating({
    elements: { reference: target || undefined },
    placement: step?.placement || 'bottom',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      // `inside` steps tuck the tooltip into the target's edge (for panes that fill the screen) instead of placing it beside.
      offset(step?.inside ? ({ rects }) => ({ mainAxis: -rects.floating.height - 16 }) : ARROW + 6),
      flip({ padding: 12, fallbackAxisSideDirection: 'start' }),
      shift({ padding: 12 }),
      size({ padding: 12, apply({ availableWidth, availableHeight, elements }) { Object.assign(elements.floating.style, { maxWidth: `${Math.max(240, Math.min(360, availableWidth))}px`, maxHeight: `${Math.max(160, availableHeight)}px` }); } }),
      arrow({ element: arrowRef, padding: 8 }),
    ],
  });
  const side = placement.split('-')[0];
  const a = middlewareData.arrow;
  const style = target ? floatingStyles : { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', maxWidth: 360 };
  return (
    <Paper ref={refs.setFloating} role="dialog" aria-modal="false" aria-labelledby="tour-title" aria-describedby="tour-body" elevation={8} data-testid="tour-tooltip" data-placement={target ? side : 'center'}
      sx={{ ...style, zIndex: 1601, p: 2, width: 'max-content', overflow: 'auto' }}>
      {target && !step?.inside && (
        <Box ref={arrowRef} aria-hidden sx={{ position: 'absolute', width: ARROW * 2, height: ARROW * 2, bgcolor: 'background.paper', transform: 'rotate(45deg)', zIndex: -1,
          left: a?.x != null ? a.x : '', top: a?.y != null ? a.y : '', [OPPOSITE[side]]: -ARROW }} />
      )}
      <Typography id="tour-title" variant="subtitle1" component="h2" sx={{ fontWeight: 700 }}>{title ?? step.title}</Typography>
      <Typography id="tour-body" variant="body2" sx={{ mt: 0.5 }}>{body ?? step.body}</Typography>
      {controller}
    </Paper>
  );
}
