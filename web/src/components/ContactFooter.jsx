import { Box, Link, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';

// The administrator's terms / acceptable-use text lives on its own page (/terms); this is the link to it, or nothing if none is set.
export const hasTerms = (g) => !!g?.termsNotice?.trim();
export function TermsLink({ g, variant = 'body2' }) {
  if (!hasTerms(g)) return null;
  return <Typography variant={variant} color="text.secondary" component={variant === 'caption' ? 'div' : 'p'}><Link component={RouterLink} to="/terms">Terms and acceptable use</Link></Typography>;
}

// The contact and helpdesk details an administrator enters under Admin → General, as a list of labelled items.
export function contactItems(g) {
  if (!g) return [];
  const mail = (a) => <Link href={`mailto:${a}`}>{a}</Link>;
  return [
    g.contactName && { k: 'Contact', v: g.contactName },
    g.contactEmail && { k: 'Contact email', v: mail(g.contactEmail) },
    g.helpdeskEmail && { k: 'Helpdesk email', v: mail(g.helpdeskEmail) },
    g.helpdeskPhone && { k: 'Helpdesk phone', v: g.helpdeskPhone },
    g.helpdeskHours && { k: 'Helpdesk hours', v: g.helpdeskHours },
    g.helpdeskUrl && { k: 'Helpdesk', v: <Link href={g.helpdeskUrl} target="_blank" rel="noopener noreferrer">Helpdesk portal</Link> },
  ].filter(Boolean);
}

// Contact information. `footer` sits at the very bottom of a scrolling page (pushed down by `mt: auto` when the page is short);
// `stacked` is the narrow version for the bottom of the chat list and the Agent's Contact pane.
export default function ContactFooter({ variant = 'footer' }) {
  const { config } = useAuth();
  const g = config?.general;
  const items = contactItems(g);
  if (!items.length && !hasTerms(g)) return null;
  if (variant === 'stacked') {
    return (
      <Box component="footer" aria-label="Contact information" sx={{ p: 1.5, borderTop: 1, borderColor: 'divider' }}>
        {items.map((i) => <Typography key={i.k} variant="caption" component="div" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{i.k}: {i.v}</Typography>)}
        <TermsLink g={g} variant="caption" />
      </Box>
    );
  }
  return (
    <Box component="footer" aria-label="Contact information" sx={{ mt: 'auto', pt: 4 }}>
      <Box sx={{ borderTop: 1, borderColor: 'divider', py: 1.5, display: 'flex', flexWrap: 'wrap', columnGap: 3, rowGap: 0.5 }}>
        {items.map((i) => <Typography key={i.k} variant="body2" color="text.secondary">{i.k}: {i.v}</Typography>)}
        <TermsLink g={g} />
      </Box>
    </Box>
  );
}
