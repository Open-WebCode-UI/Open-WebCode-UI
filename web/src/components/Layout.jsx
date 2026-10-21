import { AppBar, Toolbar, Typography, Button, Box, IconButton, Tooltip } from '@mui/material';
import LogoutIcon from '@mui/icons-material/Logout';
import BrightnessAutoIcon from '@mui/icons-material/BrightnessAuto';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import { useColorMode } from '../colorMode.jsx';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import LayoutMenu from './LayoutMenu.jsx';

// Navigation entries are filtered by permission (the server enforces the same checks independently).
export const NAV = [
  { to: '/', label: 'Agent', perm: 'agent.plan', tour: 'nav-agent' },
  { to: '/chat', label: 'Chat', anyOf: ['chat.use', 'chat.general.use', 'chat.course.use'] },
  { to: '/courses', label: 'Courses', anyOf: ['course.learn', 'course.author', 'course.admin'], learnerNeedsCourses: true },
  { to: '/reports', label: 'Reports', perm: 'report.read' },
  { to: '/profile', label: 'Profile', perm: null, tour: 'nav-profile' },
  { to: '/help', label: 'Help', perm: null, tour: 'nav-help' },
  { to: '/admin', label: 'Admin', anyOf: ['course.admin', 'settings.read', 'branding.read', 'provider.read', 'user.read', 'role.read', 'idp.read', 'security.read', 'audit.read'] },
];

const NEXT = { system: 'light', light: 'dark', dark: 'system' };
const LABEL = { system: 'Device default', light: 'Light', dark: 'Dark' };
const ICON = { system: <BrightnessAutoIcon />, light: <LightModeIcon />, dark: <DarkModeIcon /> };

function ThemeToggle() {
  const { choice, setChoice } = useColorMode();
  return <Tooltip title={`Theme: ${LABEL[choice]} (click for ${LABEL[NEXT[choice]]})`}><IconButton data-tour="theme-toggle" color="inherit" onClick={() => setChoice(NEXT[choice])} aria-label={`Theme: ${LABEL[choice]}`}>{ICON[choice]}</IconButton></Tooltip>;
}

export default function Layout({ children }) {
  const { user, config, can, logout } = useAuth();
  const loc = useLocation();
  // A learner who is not enrolled in anything (and cannot create or manage courses) has no use for the Courses page.
  const manages = can('course.author') || can('course.admin');
  const items = NAV.filter((n) => (n.perm ? can(n.perm) : n.anyOf ? n.anyOf.some(can) : true)
    && (!n.learnerNeedsCourses || manages || user?.hasCourses));
  const b = config?.branding;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <AppBar position="static" color="primary" elevation={0} enableColorOnDark>
        <Toolbar variant="dense">
          {b?.logoDataUrl && <Box component="img" src={b.logoDataUrl} alt="" sx={{ height: 28, mr: 1 }} />}
          <Typography variant="h6" sx={{ mr: 3 }}>{config?.general?.appName}</Typography>
          <Box component="nav" aria-label="Main" data-tour="app-nav" sx={{ flexGrow: 1 }}>
            {items.map((n) => (
              <Button key={n.to} data-tour={n.tour} color="inherit" component={RouterLink} to={n.to} sx={{ fontWeight: (n.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.to)) ? 700 : 400 }}>{n.label}</Button>
            ))}
          </Box>
          {loc.pathname === '/' && can('agent.plan') && <LayoutMenu />}
          <ThemeToggle />
          <Typography variant="body2" sx={{ mr: 1 }}>{user?.displayName}</Typography>
          <Tooltip title="Sign out"><IconButton color="inherit" onClick={logout} aria-label="Sign out"><LogoutIcon /></IconButton></Tooltip>
        </Toolbar>
      </AppBar>
      <Box component="main" sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }}>{children}</Box>
    </Box>
  );
}
