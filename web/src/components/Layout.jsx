import { useState } from 'react';
import { AppBar, Toolbar, Typography, Button, Box, IconButton, ListSubheader, Menu, MenuItem, SpeedDial, SpeedDialAction, Tooltip } from '@mui/material';
import LogoutIcon from '@mui/icons-material/Logout';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import BrightnessAutoIcon from '@mui/icons-material/BrightnessAuto';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import { useColorMode } from '../colorMode.jsx';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import LayoutMenu from './LayoutMenu.jsx';
import { profileSectionsFor } from '../profileSections.js';

// Navigation entries are filtered by permission (the server enforces the same checks independently).
export const NAV = [
  { to: '/chat', label: 'Chat', anyOf: ['chat.use', 'chat.general.use', 'chat.course.use'] },
  { to: '/', label: 'Agent', perm: 'agent.plan', tour: 'nav-agent' },
  { to: '/courses', label: 'Courses', anyOf: ['course.learn', 'course.author', 'course.admin'], learnerNeedsCourses: true },
  { to: '/reports', label: 'Reports', perm: 'report.read' },
  { to: '/admin', label: 'Admin', anyOf: ['course.admin', 'settings.read', 'branding.read', 'provider.read', 'user.read', 'role.read', 'idp.read', 'security.read', 'audit.read'] },
];

const NEXT = { system: 'light', light: 'dark', dark: 'system' };
const LABEL = { system: 'Device default', light: 'Light', dark: 'Dark' };
const ICON = { system: <BrightnessAutoIcon />, light: <LightModeIcon />, dark: <DarkModeIcon /> };

// Color mode lives in a speed dial in the bottom-left corner. The button shows the current mode; its actions pick one.
function ColorModeDial() {
  const { choice, setChoice } = useColorMode();
  const [open, setOpen] = useState(false);
  return (
    <SpeedDial data-tour="theme-toggle" ariaLabel={`Color mode: ${LABEL[choice]}`} icon={ICON[choice]} open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} direction="up"
      FabProps={{ size: 'small', color: 'secondary' }} sx={{ position: 'fixed', left: 16, bottom: 16, zIndex: (t) => t.zIndex.speedDial }}>
      {Object.keys(LABEL).map((k) => (
        <SpeedDialAction key={k} icon={ICON[k]} tooltipTitle={LABEL[k]} tooltipOpen
          FabProps={{ 'aria-label': LABEL[k], 'aria-pressed': choice === k, color: choice === k ? 'primary' : 'default', size: 'small' }}
          onClick={() => { setChoice(k); setOpen(false); }} />
      ))}
    </SpeedDial>
  );
}

// The signed-in name opens a menu under it, with one entry for each profile page the user can open.
function UserMenu({ name }) {
  const { can } = useAuth();
  const [anchor, setAnchor] = useState(null);
  const close = () => setAnchor(null);
  return (
    <>
      <Button data-tour="nav-profile" color="inherit" aria-haspopup="menu" aria-controls="user-menu" aria-expanded={!!anchor} onClick={(e) => setAnchor(e.currentTarget)} endIcon={<ArrowDropDownIcon />} sx={{ mr: 1, textTransform: 'none' }}>{name}</Button>
      <Menu id="user-menu" anchorEl={anchor} open={!!anchor} onClose={close} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
        <ListSubheader disableSticky sx={{ lineHeight: '32px' }}>Profile</ListSubheader>
        {profileSectionsFor(can).map((s) => <MenuItem key={s.path} component={RouterLink} to={`/profile/${s.path}`} onClick={close}>{s.label}</MenuItem>)}
      </Menu>
    </>
  );
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
          <Button data-tour="nav-help" color="inherit" component={RouterLink} to="/help" sx={{ fontWeight: loc.pathname.startsWith('/help') ? 700 : 400 }}>Help</Button>
          {user && <UserMenu name={user.displayName} />}
          <Tooltip title="Sign out"><IconButton color="inherit" onClick={logout} aria-label="Sign out"><LogoutIcon /></IconButton></Tooltip>
        </Toolbar>
      </AppBar>
      <ColorModeDial />
      <Box component="main" sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }}>{children}</Box>
    </Box>
  );
}
