import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button, Stack } from '@mui/material';
import { useTutorial } from './TutorialProvider.jsx';
import { useTourTarget } from './useTourTarget.js';
import TourOverlay from './TourOverlay.jsx';
import TourTooltip from './TourTooltip.jsx';

// Renders whatever the current step needs: the spotlight + tooltip on its target, or a centered card when the
// target is not on this page (offering to go there) or never appears.
export default function TourRoot() {
  const t = useTutorial();
  const { step, onRoute, skip, gotoStepRoute } = t;
  const { el, timedOut } = useTourTarget(step?.target, { enabled: t.isActive && onRoute, timeoutMs: step?.optional ? 800 : 2500 });

  useEffect(() => {
    if (!t.isActive) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') skip(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [t.isActive, skip]);

  // An optional step whose element is not on screen (hidden panel, feature turned off) is passed over.
  const skipIt = t.isActive && onRoute && timedOut && !el && step?.optional;
  useEffect(() => { if (skipIt) t.skipMissing(); }, [skipIt, step?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!t.isActive || !step || skipIt) return null;

  let content;
  if (!onRoute) {
    // The element lives on another page: wait for the user to follow the engine there, then the real step appears.
    content = (
      <>
        <TourOverlay target={null} />
        <TourTooltip target={null} step={step} title={step.title} body={`This step is on another page. ${step.body}`}
          controller={<FallbackControls onGo={gotoStepRoute} goLabel="Go there" />} />
      </>
    );
  } else if (el) {
    content = (
      <>
        <TourOverlay target={el} interactive={!!step.navigate} />
        <TourTooltip key={step.id} target={el} step={step} />
      </>
    );
  } else if (timedOut) {
    content = (<><TourOverlay target={null} /><TourTooltip target={null} step={step} body={step.body} /></>);
  } else content = null; // still looking for the element

  return content ? createPortal(content, document.body) : null;
}

function FallbackControls({ onGo, goLabel }) {
  const { skip } = useTutorial();
  return (
    <Stack direction="row" spacing={1} sx={{ mt: 2 }} justifyContent="flex-end">
      <Button size="small" color="inherit" onClick={skip}>Skip</Button>
      <Button size="small" variant="contained" onClick={onGo} autoFocus>{goLabel}</Button>
    </Stack>
  );
}
