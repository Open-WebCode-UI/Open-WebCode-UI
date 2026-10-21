import { Typography } from '@mui/material';
import { useAuth } from '../AuthContext.jsx';

export default function AiDisclaimer() {
  const cfg = useAuth()?.config, g = cfg?.general;
  const name = cfg?.branding?.personaName?.trim() || 'The assistant';
  const text = g?.aiDisclaimer?.trim() || `${name} is AI and can make mistakes. Always double check results.`;
  return <Typography variant="caption" color="text.secondary" align="center" sx={{ display: 'block', px: 1.5, pb: 0.75 }}>{text}</Typography>;
}
