import { Button, Stack, Typography } from '@mui/material';
import { useTutorial } from './TutorialProvider.jsx';

// Back / Skip / Next / Finish. The primary button reads "Finish" on the last step.
export default function TourController() {
  const { index, total, isLast, step, atDestination, back, next, skip, finish } = useTutorial();
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 2 }}>
      <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>{index + 1} of {total}</Typography>
      {!isLast && <Button size="small" color="inherit" onClick={skip}>Skip</Button>}
      {index > 0 && <Button size="small" onClick={back}>Back</Button>}
      {isLast
        ? <Button size="small" variant="contained" onClick={finish} autoFocus>Finish</Button>
        : <Button size="small" variant="contained" onClick={next} autoFocus>{step?.navigate && !atDestination ? 'Take me there' : 'Next'}</Button>}
    </Stack>
  );
}
