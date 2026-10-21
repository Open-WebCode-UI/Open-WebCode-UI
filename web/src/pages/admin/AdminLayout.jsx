import { Box } from '@mui/material';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import SectionShell from '../../components/SectionShell.jsx';
import { useAuth } from '../../AuthContext.jsx';
import General from './General.jsx';
import Servers from './Servers.jsx';
import Branding from './Branding.jsx';
import Users from './Users.jsx';
import Saml from './Saml.jsx';
import Security from './Security.jsx';
import Audit from './Audit.jsx';
import McpServers from './McpServers.jsx';
import WebSearch from './WebSearch.jsx';
import Tls from './Tls.jsx';
import Courses from './Courses.jsx';

export const ADMIN_PAGES = [
  { path: 'general', label: 'General', perm: 'settings.read', el: <General /> },
  { path: 'servers', label: 'Server (AI services)', perm: 'provider.read', el: <Servers /> },
  { path: 'mcp', label: 'MCP servers', perm: 'mcp.read', el: <McpServers /> },
  { path: 'web-search', label: 'Web search', perm: 'settings.read', el: <WebSearch /> },
  { path: 'https', label: 'HTTPS', perm: 'settings.read', el: <Tls /> },
  { path: 'branding', label: 'Branding', perm: 'branding.read', el: <Branding /> },
  { path: 'users', label: 'Users & roles', perm: 'user.read', el: <Users /> },
  { path: 'courses', label: 'Courses', perm: 'course.admin', el: <Courses /> },
  { path: 'saml', label: 'SAML', perm: 'idp.read', el: <Saml /> },
  { path: 'security', label: 'Security (MFA)', perm: 'security.read', el: <Security /> },
  { path: 'audit', label: 'Audit log', perm: 'audit.read', el: <Audit /> },
];

export default function AdminLayout() {
  const { can } = useAuth(); const loc = useLocation();
  const pages = ADMIN_PAGES.filter((p) => can(p.perm));
  if (!pages.length) return <Box sx={{ p: 3 }}>You do not have access to any administration pages.</Box>;
  return (
    <SectionShell contact ariaLabel="Administration" items={pages.map((p) => ({ to: `/admin/${p.path}`, label: p.label, selected: loc.pathname === `/admin/${p.path}` }))}>
      <Routes>
        {pages.map((p) => <Route key={p.path} path={p.path} element={p.el} />)}
        <Route path="*" element={<Navigate to={`/admin/${pages[0].path}`} replace />} />
      </Routes>
    </SectionShell>
  );
}
