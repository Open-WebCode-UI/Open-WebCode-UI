import { useEffect, useState } from 'react';
import { Box, Fade, Typography } from '@mui/material';
import LightbulbIcon from '@mui/icons-material/LightbulbOutlined';

// One short tip at a time, changing every few seconds while the agent works.
export default function ThinkingTips({ tips, intervalMs = 7000 }) {
  const [i, setI] = useState(0);
  useEffect(() => { if (tips.length < 2) return undefined; const t = setInterval(() => setI((n) => (n + 1) % tips.length), intervalMs); return () => clearInterval(t); }, [tips.length, intervalMs]);
  if (!tips.length) return null;
  return (
    <Box data-testid="tip" aria-live="off" sx={{ display: 'flex', gap: 0.75, alignItems: 'flex-start', color: 'text.secondary', px: 0.5 }}>
      <LightbulbIcon fontSize="small" sx={{ mt: '2px' }} />
      <Fade in key={i} timeout={400}><Typography variant="caption" sx={{ fontStyle: 'italic' }}>{tips[i % tips.length].startsWith('Fun fact:') ? '' : 'Tip: '}{tips[i % tips.length]}</Typography></Fade>
    </Box>
  );
}
