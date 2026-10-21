import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import { autoUpdate } from '@floating-ui/react-dom';

const PAD = 6;
const layer = { position: 'fixed', zIndex: 1600 };

// Dims the app and cuts a spotlight around the target. `interactive` leaves the spotlight clickable (navigation steps);
// otherwise the whole screen is blocked so the tour cannot be derailed mid-step.
export default function TourOverlay({ target, interactive = false, onBackdropClick }) {
  const [rect, setRect] = useState(null);
  useEffect(() => {
    if (!target) { setRect(null); return undefined; }
    target.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const measure = () => { const r = target.getBoundingClientRect(); setRect({ top: r.top - PAD, left: r.left - PAD, width: r.width + 2 * PAD, height: r.height + 2 * PAD }); };
    return autoUpdate(target, document.body, measure, { animationFrame: false });
  }, [target]);

  const dim = 'rgba(0,0,0,0.6)';
  if (!rect) return <Box data-testid="tour-overlay" onClick={onBackdropClick} sx={{ ...layer, inset: 0, bgcolor: dim }} />;
  const blocker = { ...layer, bgcolor: 'transparent' };
  return (
    <>
      {/* Visual: a transparent box whose huge shadow dims everything else. It glides between steps unless motion is reduced. */}
      <Box data-testid="tour-overlay" aria-hidden sx={{ ...layer, pointerEvents: 'none', borderRadius: 1, boxShadow: `0 0 0 100vmax ${dim}`, top: rect.top, left: rect.left, width: rect.width, height: rect.height, transition: 'all 200ms ease', '@media (prefers-reduced-motion: reduce)': { transition: 'none' } }} />
      {interactive ? (
        <>
          <Box onClick={onBackdropClick} sx={{ ...blocker, top: 0, left: 0, right: 0, height: Math.max(rect.top, 0) }} />
          <Box onClick={onBackdropClick} sx={{ ...blocker, top: rect.top + rect.height, left: 0, right: 0, bottom: 0 }} />
          <Box onClick={onBackdropClick} sx={{ ...blocker, top: rect.top, left: 0, width: Math.max(rect.left, 0), height: rect.height }} />
          <Box onClick={onBackdropClick} sx={{ ...blocker, top: rect.top, left: rect.left + rect.width, right: 0, height: rect.height }} />
        </>
      ) : <Box onClick={onBackdropClick} sx={{ ...blocker, inset: 0 }} />}
    </>
  );
}
