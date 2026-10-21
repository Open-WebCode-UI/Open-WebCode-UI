import { Box, Typography } from '@mui/material';
import { useAuth } from '../../AuthContext.jsx';
import ContactFooter, { contactItems, hasTerms } from '../ContactFooter.jsx';

export default function ContactPane() {
  const { config } = useAuth();
  if (!contactItems(config?.general).length && !hasTerms(config?.general)) return <Box sx={{ p: 1.5 }}><Typography variant="body2" color="text.secondary">No contact information has been set. An administrator can add it under Admin → General.</Typography></Box>;
  return <Box sx={{ height: '100%', overflow: 'auto' }}><ContactFooter variant="stacked" /></Box>;
}
