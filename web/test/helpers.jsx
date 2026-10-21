import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material/styles';
import { vi } from 'vitest';
import { AuthProvider } from '../src/AuthContext.jsx';
import { buildTheme } from '../src/theme.js';

export const ALL = ['project.read', 'project.write', 'files.read', 'files.write', 'agent.plan', 'agent.act', 'chat.use', 'download.code', 'git.commit', 'checkpoint.read', 'checkpoint.write', 'provider.use', 'profile.prompt.edit', 'profile.skills.edit'];
export const SHELL = [...ALL, 'terminal.use', 'agent.shell.run'];
export const ADMIN = [...ALL, 'settings.read', 'settings.write', 'branding.read', 'branding.write', 'provider.read', 'provider.write', 'user.read', 'user.write', 'role.read', 'role.write', 'idp.read', 'idp.write', 'security.read', 'security.write', 'audit.read', 'mfa.reset', 'course.admin'];

export const PUBLIC = {
  general: { appName: 'Acme Code', tagline: 'Ship it', helpdeskEmail: 'help@acme.test', helpdeskPhone: '555-0100', helpdeskUrl: 'https://help.acme.test', helpdeskHours: '9-5', supportMessage: 'Call us', loginBanner: '', termsNotice: '', contactName: '', contactEmail: '' },
  branding: { primaryColor: '#112233', secondaryColor: '#009688', backgroundColor: '#f5f6fa', surfaceColor: '#fff', defaultMode: 'light', fontFamily: 'Roboto', borderRadius: 8, density: 'comfortable', monacoTheme: 'vs-dark', logoDataUrl: '', faviconDataUrl: '', fontUrl: '', loginText: '' },
  samlEnabled: true, localLoginEnabled: true,
};
export const userWith = (permissions, over = {}) => ({ id: 1, displayName: 'Dee Veloper', email: 'd@x.test', source: 'saml', roles: ['developer'], permissions, mustChangePassword: false, ...over });

// Routes a fake fetch by "METHOD /path" (exact path without query) or "/path" prefix; records calls.
export function mockFetch(routes) {
  const calls = [];
  const fn = vi.fn(async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    let body = init.body; if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* keep text */ } }
    calls.push({ method, url, body, headers: init.headers });
    const key = `${method} ${String(url).split('?')[0]}`;
    const hit = routes[key] ?? routes[String(url).split('?')[0]];
    if (hit === undefined) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    const out = typeof hit === 'function' ? await hit(init) : hit;
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  globalThis.fetch = fn;
  fn.calls = calls;
  return fn;
}

export function renderApp(ui, { route = '/', user, stage = 'full', routes = {}, config = PUBLIC } = {}) {
  const f = mockFetch({
    '/api/public-config': config,
    '/api/auth/me': user ? { stage, csrf: 'tok', user, stepup: true } : new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 }),
    ...routes,
  });
  const utils = render(<MemoryRouter initialEntries={[route]}><ThemeProvider theme={buildTheme(config.branding)}><AuthProvider>{ui}</AuthProvider></ThemeProvider></MemoryRouter>);
  return { ...utils, fetch: f };
}
