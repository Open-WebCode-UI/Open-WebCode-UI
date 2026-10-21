import { Box, Button, Paper, Typography } from '@mui/material';
import { Link as RouterLink, Navigate } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import { hasTerms } from '../components/ContactFooter.jsx';

// The administrator's terms / acceptable-use text (Admin → General). Public, so it can be read before signing in; `standalone` is the signed-out frame.
export default function Terms({ standalone }) {
  const { config, loading } = useAuth();
  const g = config?.general;
  if (loading) return null;
  if (!hasTerms(g)) return <Navigate to="/" replace />;
  const page = (
    <Box sx={{ p: { xs: 2, md: 4 }, maxWidth: 820, width: '100%', mx: 'auto' }}>
      <Typography variant="h4" component="h1" gutterBottom>Terms and acceptable use</Typography>
      <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}><Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{g.termsNotice}</Typography></Paper>
      {standalone && <Button component={RouterLink} to="/" sx={{ mt: 2 }}>← Back to sign in</Button>}
    </Box>
  );
  return standalone ? <Box sx={{ minHeight: '100vh' }}>{page}</Box> : <Box sx={{ height: '100%', overflow: 'auto' }}>{page}</Box>;
}
