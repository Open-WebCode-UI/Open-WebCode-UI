import { useCallback, useEffect, useMemo, useState } from 'react';
import { ThemeProvider, CssBaseline, CircularProgress, Box, GlobalStyles } from '@mui/material';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { buildTheme, DEFAULT_A11Y } from './theme.js';
import { put } from './api.js';
import { ColorModeProvider, useColorMode } from './colorMode.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import MfaFlow from './pages/MfaFlow.jsx';
import ChangePassword from './pages/ChangePassword.jsx';
import IDE from './pages/IDE.jsx';
import Chat from './pages/Chat.jsx';
import Profile from './pages/Profile.jsx';
import Courses from './pages/Courses.jsx';
import Reports from './pages/Reports.jsx';
import AdminLayout from './pages/admin/AdminLayout.jsx';
import Help from './pages/Help.jsx';
import Terms from './pages/Terms.jsx';
import { TutorialProvider } from './tour/TutorialProvider.jsx';
import TourRoot from './tour/TourRoot.jsx';
import SetupWizard from './components/SetupWizard.jsx';

function Themed({ children }) {
  const { config, user } = useAuth();
  const { mode } = useColorMode();
  const p = user?.preferences;
  const a11y = useMemo(() => ({ ...DEFAULT_A11Y, ...(p ? { fontScale: p.fontScale, reduceMotion: p.reduceMotion, highContrast: p.highContrast, underlineLinks: p.underlineLinks } : {}) }), [p]);
  const theme = useMemo(() => buildTheme(config?.branding, mode, a11y), [config, mode, a11y]);
  useEffect(() => {
    const b = config?.branding; const g = config?.general;
    if (g?.appName) document.title = g.appName;
    if (b?.faviconDataUrl) { let l = document.querySelector('link[rel=icon]'); if (!l) { l = document.createElement('link'); l.rel = 'icon'; document.head.appendChild(l); } l.href = b.faviconDataUrl; }
    if (b?.fontUrl) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = b.fontUrl; document.head.appendChild(l); return () => l.remove(); }
  }, [config]);
  return <ThemeProvider theme={theme}><CssBaseline />{a11y.reduceMotion && <GlobalStyles styles={{ '*, *::before, *::after': { animationDuration: '0.001ms !important', animationIterationCount: '1 !important', transitionDuration: '0.001ms !important', scrollBehavior: 'auto !important' } }} />}{a11y.underlineLinks && <GlobalStyles styles={{ a: { textDecoration: 'underline' } }} />}{children}</ThemeProvider>;
}

function Routed() {
  const { loading, user, stage, can } = useAuth();
  const [setupOpen, setSetupOpen] = useState(false); // the tour waits until the administrator's setup is done
  if (loading) return <Box sx={{ display: 'grid', placeItems: 'center', height: '100vh' }}><CircularProgress /></Box>;
  if (!user) return <Routes><Route path="/terms" element={<Terms standalone />} /><Route path="/login/local" element={<Login local />} /><Route path="*" element={<Login />} /></Routes>;
  if (stage !== 'full') return <MfaFlow />;
  if (user.mustChangePassword) return <ChangePassword />;
  const canChat = can('chat.use') || can('chat.general.use') || (can('chat.course.use') && can('course.author'));
  const home = can('agent.plan') ? <IDE /> : canChat ? <Navigate to="/chat" replace /> : <Navigate to="/profile" replace />;
  return (
    <TutorialProvider>
    <Layout>
      <Routes>
        <Route path="/" element={home} />
        <Route path="/chat" element={canChat ? <Chat /> : <Navigate to="/" replace />} />
        <Route path="/courses/*" element={can('course.learn') || can('course.author') ? <Courses /> : <Navigate to="/" replace />} />
        <Route path="/reports" element={can('report.read') ? <Reports /> : <Navigate to="/" replace />} />
        <Route path="/admin/reports" element={<Navigate to="/reports" replace />} />
        <Route path="/profile/*" element={<Profile />} />
        <Route path="/help/:topic?" element={<Help />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/admin/*" element={<AdminLayout />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
    <SetupWizard onActive={setSetupOpen} />
    {!setupOpen && <TourRoot />}
    </TutorialProvider>
  );
}

function WithColorMode({ children }) {
  const { config, user, refresh } = useAuth();
  const onSave = useCallback((colorMode) => { if (user) put('/api/profile/preferences', { colorMode }).then(refresh).catch(() => {}); }, [user, refresh]);
  return <ColorModeProvider defaultChoice={config?.branding?.defaultMode} savedChoice={user?.preferences?.colorMode} onSave={onSave}>{children}</ColorModeProvider>;
}

export default function App() {
  return <AuthProvider><WithColorMode><Themed><BrowserRouter><Routed /></BrowserRouter></Themed></WithColorMode></AuthProvider>;
}
