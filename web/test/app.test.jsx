import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Layout from '../src/components/Layout.jsx';
import Login from '../src/pages/Login.jsx';
import Profile from '../src/pages/Profile.jsx';
import AgentPanel from '../src/components/AgentPanel.jsx';
import AdminLayout from '../src/pages/admin/AdminLayout.jsx';
import General from '../src/pages/admin/General.jsx';
import Saml from '../src/pages/admin/Saml.jsx';
import { buildTheme, DEFAULT_BRANDING } from '../src/theme.js';
import { renderApp, userWith, ALL, ADMIN, PUBLIC } from './helpers.jsx';

describe('navigation is permission-gated', () => {
  it('developers do not see Admin; administrators do', async () => {
    const { unmount } = renderApp(<Layout><div /></Layout>, { user: userWith(ALL) });
    await screen.findByRole('link', { name: 'Agent' });
    expect(screen.getByRole('link', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
    unmount();
    renderApp(<Layout><div /></Layout>, { user: userWith(ADMIN) });
    expect(await screen.findByRole('link', { name: 'Admin' })).toBeInTheDocument();
  });
  it('hides Chat when the role lacks chat.use and shows the branded app name', async () => {
    renderApp(<Layout><div /></Layout>, { user: userWith(['agent.plan']) });
    expect(await screen.findByText('Acme Code')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Chat' })).not.toBeInTheDocument();
  });
  it('admin sidebar lists only the pages the role may read', async () => {
    renderApp(<AdminLayout />, { route: '/admin/general', user: userWith([...ALL, 'settings.read', 'audit.read']), routes: { '/api/admin/general': { appName: 'x', secretGlobs: [], execMode: 'files_only' }, '/api/admin/audit': { rows: [], integrity: { ok: true, count: 0 } } } });
    const nav = await screen.findByRole('navigation', { name: 'Administration' });
    expect(within(nav).getByText('General')).toBeInTheDocument(); expect(within(nav).getByText('Audit log')).toBeInTheDocument();
    for (const hidden of ['SAML', 'Users & roles', 'Branding', 'Security (MFA)', 'Server (AI services)']) expect(within(nav).queryByText(hidden)).not.toBeInTheDocument();
  });
});

describe('login page', () => {
  it('shows the regular form first, the SSO button below it, and helpdesk info', async () => {
    renderApp(<Login />);
    expect(await screen.findByLabelText(/Password/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in with SSO' })).toHaveAttribute('href', '/auth/saml/login');
    expect(screen.getByText(/help@acme.test/)).toBeInTheDocument(); expect(screen.getByText(/555-0100/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /helpdesk portal/i })).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
  it('uses the button text the administrator chose', async () => {
    renderApp(<Login />, { config: { ...PUBLIC, ssoButtonText: 'Sign in with Acme' } });
    expect(await screen.findByRole('link', { name: 'Sign in with Acme' })).toBeInTheDocument();
  });
  it('has no SSO button when SSO is not configured', async () => {
    renderApp(<Login />, { config: { ...PUBLIC, samlEnabled: false } });
    await screen.findByLabelText(/Password/);
    expect(screen.queryByRole('link', { name: /sso/i })).not.toBeInTheDocument(); expect(screen.queryByText(/not configured/i)).not.toBeInTheDocument();
  });
  it('shows only SSO when local sign-in is turned off', async () => {
    renderApp(<Login />, { config: { ...PUBLIC, localLoginEnabled: false } });
    await screen.findByRole('link', { name: 'Log in with SSO' });
    expect(screen.queryByLabelText(/Password/)).not.toBeInTheDocument();
  });
  it('posts credentials', async () => {
    const { fetch } = renderApp(<Login />, { routes: { 'POST /api/auth/local/login': { stage: 'mfa', csrf: 'c' } } });
    await userEvent.type(await screen.findByLabelText(/Username/), 'alice');
    await userEvent.type(screen.getByLabelText(/Password/), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.url === '/api/auth/local/login').body).toEqual({ username: 'alice', password: 'pw' }));
  });
});

describe('profile prompt editor', () => {
  const prompts = { kinds: ['plan', 'act', 'chat'], defaults: { plan: 'DEFAULT PLAN', act: 'DEFAULT ACT', chat: 'DEFAULT CHAT' }, overrides: { plan: '', act: '', chat: 'custom chat' } };
  it('saves an override and resets to default', async () => {
    const { fetch } = renderApp(<Profile />, { route: '/profile/prompts', user: userWith(ALL), routes: { '/api/profile/prompts': prompts, 'PUT /api/profile/prompts': { ok: true }, '/api/auth/sessions': [] } });
    const box = await screen.findByLabelText('plan system prompt');
    await userEvent.type(box, 'be terse');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'PUT').body).toEqual({ plan: 'be terse' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(fetch.calls.filter((c) => c.method === 'PUT').at(-1).body).toEqual({ plan: null }));
    expect(await screen.findByText(/Reset to default/, { selector: '.MuiAlert-message' })).toBeInTheDocument();
  });
  it('is read-only without profile.prompt.edit', async () => {
    renderApp(<Profile />, { route: '/profile/prompts', user: userWith(['agent.plan']), routes: { '/api/profile/prompts': prompts, '/api/auth/sessions': [] } });
    expect(await screen.findByLabelText('plan system prompt')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot edit prompts/i)).toBeInTheDocument();
  });
});

describe('agent panel modes', () => {
  const routes = { '/api/models': { models: [{ id: 1, label: 'Fake', provider: 'p' }], defaults: {} } };
  it('starts in read-only Plan mode and disables Act without agent.act', async () => {
    renderApp(<AgentPanel project={{ id: 1 }} />, { user: userWith(['agent.plan', 'provider.use']), routes });
    expect(await screen.findByText(/Plan mode: read-only/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Act mode' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Plan mode' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('allows switching to Act with agent.act and explains that edits are possible', async () => {
    renderApp(<AgentPanel project={{ id: 1 }} />, { user: userWith(ALL), routes });
    await userEvent.click(await screen.findByRole('button', { name: 'Act mode' }));
    expect(screen.getByText(/Act mode: the agent can edit files/)).toBeInTheDocument();
  });
  it('sends the selected mode and renders a proposed plan with an approve button', async () => {
    const sse = `data: ${JSON.stringify({ type: 'start', conversationId: 5 })}\n\ndata: ${JSON.stringify({ type: 'plan', plan: '1. Do the thing' })}\n\ndata: ${JSON.stringify({ type: 'done' })}\n\n`;
    const { fetch } = renderApp(<AgentPanel project={{ id: 7 }} />, { user: userWith(ALL), routes: { ...routes, 'POST /api/agent/turn': () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }) } });
    await userEvent.type(await screen.findByLabelText('Message'), 'build it');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Do the thing')).toHaveProperty('tagName', 'LI'); // plan is rendered as Markdown (numbered list)
    const turn = fetch.calls.find((c) => c.url === '/api/agent/turn');
    expect(turn.body).toMatchObject({ projectId: 7, mode: 'plan', message: 'build it' });
    expect(screen.getByRole('button', { name: /approve & switch to act/i })).toBeEnabled();
  });
});

describe('agent panel stickiness and banner', () => {
  const two = { '/api/models': { models: [{ id: 1, label: 'Alpha', provider: 'p' }, { id: 2, label: 'Beta', provider: 'p' }], defaults: { plan: 1 } } };
  it('keeps the model you picked (and sends it) rather than snapping back to the default', async () => {
    localStorage.clear();
    const sse = `data: ${JSON.stringify({ type: 'start', conversationId: 5 })}\n\ndata: ${JSON.stringify({ type: 'done' })}\n\n`;
    const { fetch } = renderApp(<AgentPanel project={{ id: 31 }} />, { user: userWith(ALL), routes: { ...two, 'POST /api/agent/turn': () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }) } });
    await userEvent.click(await screen.findByRole('button', { name: /^Model:/ }));
    await userEvent.click(await screen.findByRole('radio', { name: /Beta/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.type(screen.getByLabelText('Message'), 'go');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.url === '/api/agent/turn').body.modelId).toBe(2));
    expect(screen.getByRole('button', { name: /^Model:/ })).toHaveTextContent('Beta');
    expect(localStorage.getItem('lastModel:agent')).toBe('2');
  });
  it('starts on the last model used elsewhere, and the mode banner can be dismissed', async () => {
    localStorage.setItem('lastModel:agent', '2');
    renderApp(<AgentPanel project={{ id: 32 }} />, { user: userWith(ALL), routes: two });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Model:/ })).toHaveTextContent('Beta'));
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByText(/Plan mode: read-only/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Act mode' }));
    expect(screen.getByText(/Act mode: the agent can edit files/)).toBeInTheDocument();
  });
});

describe('general settings', () => {
  it('changes the execution mode through the dedicated endpoint', async () => {
    const { fetch } = renderApp(<General />, { user: userWith(ADMIN), routes: {
      '/api/admin/general': { appName: 'Acme', tagline: '', contactName: '', contactEmail: '', helpdeskEmail: '', helpdeskPhone: '', helpdeskUrl: '', helpdeskHours: '', supportMessage: '', loginBanner: '', termsNotice: '', maxUploadMb: 50, execMode: 'files_only', shellTimeoutSec: 60, shellOutputCapBytes: 1000, maxAgentIterations: 30, secretGlobs: ['.env'] },
      'PUT /api/admin/general/exec-mode': { execMode: 'workspace_shell' } } });
    await userEvent.click(await screen.findByLabelText(/Agent execution mode/));
    await userEvent.click(await screen.findByRole('option', { name: /server-side workspace/i }));
    await waitFor(() => expect(fetch.calls.find((c) => c.url === '/api/admin/general/exec-mode').body).toEqual({ execMode: 'workspace_shell' }));
    expect(await screen.findByText(/Shell commands run as the server/i)).toBeInTheDocument();
  });
});

describe('SAML settings', () => {
  const saml = { settings: { enabled: true, metadataSource: 'manual', metadataUrl: '', idpEntityId: '', ssoUrl: '', sloUrl: '', idpCerts: [], spEntityId: '', spCert: '', signAuthnRequests: false, wantAssertionsSigned: true, wantResponseSigned: false, allowPrivateMetadataHosts: false,
    nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', uniqueIdAttribute: '', attrEmail: 'email', attrFirstName: 'firstName', attrLastName: 'lastName', attrDisplayName: 'displayName', attrGroups: 'memberOf', clockSkewSec: 60 },
    nameIdFormats: { persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', unspecified: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified', emailAddress: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', transient: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient' },
    acsUrl: 'https://app.test/auth/saml/acs', spEntityIdEffective: 'https://app.test/auth/saml/metadata', spMetadataUrl: 'https://app.test/auth/saml/metadata' };
  const preview = { idpEntityId: 'https://idp.test/e', ssoUrl: 'https://idp.test/sso', sloUrl: '', idpCerts: ['-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----'], nameIdFormats: [saml.nameIdFormats.persistent], suggestedNameIdFormat: saml.nameIdFormats.persistent, persistentAvailable: true };
  it('has an "Auto-populate IdP metadata" button that previews then fills the form (URL source)', async () => {
    const { fetch } = renderApp(<Saml />, { user: userWith(ADMIN), routes: { '/api/admin/saml': saml, 'POST /api/admin/saml/metadata/preview': preview } });
    await userEvent.type(await screen.findByLabelText(/Metadata URL/), 'https://idp.test/metadata');
    await userEvent.click(screen.getByRole('button', { name: 'Auto-populate IdP metadata' }));
    expect(await screen.findByText('https://idp.test/e')).toBeInTheDocument();
    expect(fetch.calls.find((c) => c.url.endsWith('/metadata/preview')).body).toEqual({ url: 'https://idp.test/metadata' });
    await userEvent.click(screen.getByRole('button', { name: 'Use these' }));
    expect(screen.getByLabelText('IdP entity ID')).toHaveValue('https://idp.test/e');
    expect(screen.getByLabelText('SSO URL')).toHaveValue('https://idp.test/sso');
  });
  it('supports uploading a metadata file', async () => {
    const { fetch } = renderApp(<Saml />, { user: userWith(ADMIN), routes: { '/api/admin/saml': saml, 'POST /api/admin/saml/metadata/preview': preview } });
    await userEvent.click(await screen.findByRole('button', { name: 'Upload file' }));
    const file = new File(['<EntityDescriptor/>'], 'idp.xml', { type: 'text/xml' });
    await userEvent.upload(document.querySelector('input[type=file]'), file);
    await userEvent.click(await screen.findByRole('button', { name: 'Auto-populate IdP metadata' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.url.endsWith('/metadata/preview')).body).toEqual({ xml: '<EntityDescriptor/>' }));
  });
  it('encourages persistent NameID and warns for unspecified', async () => {
    renderApp(<Saml />, { user: userWith(ADMIN), routes: { '/api/admin/saml': saml } });
    await userEvent.click(await screen.findByRole('tab', { name: 'Attributes & NameID' }));
    expect(screen.getByText(/Persistent is a good choice/)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/NameID format requested/));
    await userEvent.click(await screen.findByRole('option', { name: 'Unspecified' }));
    expect(await screen.findByText(/may contain a human-readable value/)).toBeInTheDocument();
  });
  it('shows SP metadata details and hides write actions without idp.write', async () => {
    renderApp(<Saml />, { user: userWith([...ALL, 'idp.read']), routes: { '/api/admin/saml': saml } });
    await userEvent.click(await screen.findByRole('tab', { name: 'Service provider' }));
    expect(screen.getByLabelText(/Assertion Consumer Service/)).toHaveValue('https://app.test/auth/saml/acs');
    expect(screen.queryByRole('button', { name: /Generate SP certificate/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save SAML settings' })).not.toBeInTheDocument();
  });
});

describe('theme', () => {
  it('builds the MUI theme from branding settings', () => {
    const t = buildTheme({ ...DEFAULT_BRANDING, primaryColor: '#abcdef', borderRadius: 3, fontFamily: 'Inter', density: 'compact' });
    expect(t.palette.primary.main).toBe('#abcdef'); expect(t.shape.borderRadius).toBe(3); expect(t.typography.fontFamily).toBe('Inter');
    expect(t.components.MuiButton.defaultProps.size).toBe('small');
    expect(buildTheme(DEFAULT_BRANDING, 'dark').palette.mode).toBe('dark');
  });
});

describe('adding an AI connection: model discovery', () => {
  const emptyList = [];
  const routes = (extra = {}) => ({
    '/api/admin/providers': emptyList, '/api/admin/roles': { roles: [{ id: 1, name: 'developer' }], groupMap: [] }, '/api/models': { models: [], defaults: {} }, ...extra,
  });
  const openDialog = async () => { await userEvent.click(await screen.findByRole('button', { name: 'Add connection' })); await screen.findByText('Add connection', { selector: 'h2' }); };

  it('queries the server for models and presents them in a multi-select; saving adds the chosen ones', async () => {
    const Servers = (await import('../src/pages/admin/Servers.jsx')).default;
    const { fetch } = renderApp(<Servers />, { user: userWith(ADMIN), routes: routes({
      'POST /api/admin/providers/discover': { ok: true, models: ['gpt-4o', 'gpt-4o-mini', 'o3'] },
      'POST /api/admin/providers': { id: 9, name: 'OpenAI', type: 'openai', models: [] },
      'POST /api/admin/providers/9/models': { id: 9, models: [] },
    }) });
    await openDialog();
    await userEvent.type(screen.getByLabelText('Name'), 'OpenAI');
    expect(screen.getByLabelText(/Base URL/)).toHaveValue('https://api.openai.com/v1');
    await userEvent.type(screen.getByLabelText(/API key/), 'sk-test');
    await userEvent.click(screen.getByRole('button', { name: 'Connect & load models' }));
    await screen.findByText('3 model(s) available');
    expect(fetch.calls.find((c) => c.url.endsWith('/discover')).body).toEqual({ type: 'openai', config: { baseUrl: 'https://api.openai.com/v1' }, secret: 'sk-test' });
    await userEvent.click(screen.getByLabelText('Models to make available'));
    const list = await screen.findByRole('listbox');
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['gpt-4o', 'gpt-4o-mini', 'o3']);
    await userEvent.click(within(list).getByRole('option', { name: 'gpt-4o-mini' }));
    await userEvent.click(within(await screen.findByRole('listbox')).getByRole('option', { name: 'o3' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.calls.filter((c) => /\/providers\/9\/models$/.test(c.url)).map((c) => c.body.modelId)).toEqual(['gpt-4o-mini', 'o3']));
  });

  it('pre-fills the base URL for the chosen type but keeps one the administrator typed', async () => {
    const Servers = (await import('../src/pages/admin/Servers.jsx')).default;
    renderApp(<Servers />, { user: userWith(ADMIN), routes: routes() });
    await openDialog();
    const pickType = async (name) => { await userEvent.click(screen.getByLabelText('Type')); await userEvent.click(await screen.findByRole('option', { name })); };
    await pickType('Anthropic');
    expect(screen.getByLabelText(/Base URL/)).toHaveValue('https://api.anthropic.com');
    await pickType('LM Studio');
    expect(screen.getByLabelText(/Base URL/)).toHaveValue('http://localhost:1234/v1');
    await pickType('Azure OpenAI');
    expect(screen.getByLabelText('Endpoint')).toHaveValue('');
    await userEvent.type(screen.getByLabelText('Endpoint'), 'https://r.openai.azure.com');
    await pickType('OpenAI (ChatGPT)');
    expect(screen.getByLabelText(/Base URL/)).toHaveValue('https://r.openai.azure.com');
  });

  it('shows the failure and lets the administrator type model IDs instead', async () => {
    const Servers = (await import('../src/pages/admin/Servers.jsx')).default;
    renderApp(<Servers />, { user: userWith(ADMIN), routes: routes({ 'POST /api/admin/providers/discover': { ok: false, error: '401 Incorrect API key' } }) });
    await openDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Connect & load models' }));
    expect(await screen.findByText(/Could not list models: 401 Incorrect API key/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Models to make available'), 'my-model{Enter}');
    expect(screen.getByText('my-model')).toBeInTheDocument();
  });

  it('when editing, loads the models automatically using the stored key (providerId, no secret)', async () => {
    const Servers = (await import('../src/pages/admin/Servers.jsx')).default;
    const existing = { id: 4, name: 'Azure', type: 'azure', enabled: true, hasSecret: true, config: { baseUrl: 'https://r.openai.azure.com' }, allowedRoles: [], models: [{ id: 11, modelId: 'prod-gpt', label: 'prod-gpt', enabled: true, maxTokens: 4096 }] };
    const { fetch } = renderApp(<Servers />, { user: userWith(ADMIN), routes: routes({ '/api/admin/providers': [existing], 'POST /api/admin/providers/discover': { ok: true, models: ['prod-gpt', 'prod-o3'] } }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByText('2 model(s) available');
    expect(fetch.calls.find((c) => c.url.endsWith('/discover')).body).toEqual({ type: 'azure', config: { baseUrl: 'https://r.openai.azure.com' }, providerId: 4 });
    expect(screen.getByLabelText(/Deployments to make available/)).toBeInTheDocument(); // Azure wording
  });
});

describe('reports page', () => {
  it('lists spend by user and lets an administrator reveal session costs to users', async () => {
    const { default: Reports } = await import('../src/pages/Reports.jsx');
    const report = { totals: { cost: 1.5, requests: 3, inputTokens: 10, outputTokens: 5, activeUsers: 1, estimatedRequests: 0 }, unpriced: [], byDay: [], byModel: [{ modelRowId: 1, model: 'Alpha', provider: 'p', requests: 3, inputTokens: 10, outputTokens: 5, estimatedRequests: 0, cost: 1.5 }],
      byKind: [{ kind: 'agent', requests: 3, inputTokens: 10, outputTokens: 5, cost: 1.5 }], topSessions: [{ id: 9, title: 'Fix the build', kind: 'agent', user: 'Dee Veloper', requests: 3, tokens: 15, cost: 1.5 }], byProvider: [], month: { spent: 1.5, projected: 4 }, previous: { cost: 1, requests: 2, activeUsers: 1 },
      byUser: [{ userId: 4, name: 'Dee Veloper', username: 'dee', requests: 3, inputTokens: 10, outputTokens: 5, cost: 1.5, models: 'Alpha,Beta' }] };
    const { fetch } = renderApp(<Reports />, { user: userWith([...ADMIN, 'report.read']), routes: { '/api/reports/usage': report, 'GET /api/admin/general': { showSessionCost: false }, 'PUT /api/admin/general': { showSessionCost: true } } });
    expect((await screen.findAllByText('Dee Veloper')).length).toBeGreaterThan(0); expect(screen.getByText('Fix the build')).toBeInTheDocument(); expect(screen.getAllByText('▲ 50% vs previous period').length).toBeGreaterThan(0); expect(screen.getByText(/projected \$4\.00/)).toBeInTheDocument();
    expect(screen.getByText('Alpha, Beta')).toBeInTheDocument();
    await userEvent.click(await screen.findByLabelText(/show users what each session costs/i));
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'PUT').body).toEqual({ showSessionCost: true }));
  });
});

describe('reports daily chart', () => {
  it('stacks spend by model with axis titles, a legend, and a trend line', async () => {
    const { default: Reports } = await import('../src/pages/Reports.jsx');
    const report = { totals: { cost: 3, requests: 3, inputTokens: 1, outputTokens: 1, activeUsers: 1, estimatedRequests: 0 }, unpriced: [], byKind: [], topSessions: [], byProvider: [], byUser: [], byModel: [],
      byDay: [{ day: '2026-10-01', cost: 1, requests: 1, activeUsers: 1 }, { day: '2026-10-03', cost: 2, requests: 2, activeUsers: 1 }],
      byDayModel: [{ day: '2026-10-01', model: 'Alpha', provider: 'p', cost: 1, requests: 1 }, { day: '2026-10-03', model: 'Beta', provider: 'q', cost: 2, requests: 2 }] };
    renderApp(<Reports />, { user: userWith([...ADMIN, 'report.read']), routes: { '/api/reports/usage': report, 'GET /api/admin/general': { showSessionCost: false } } });
    expect(await screen.findByText('Spend per day (USD)')).toBeInTheDocument();
    expect(screen.getByText('Date (UTC)')).toBeInTheDocument(); expect(screen.getByText('Alpha (p)')).toBeInTheDocument(); expect(screen.getByText('Beta (q)')).toBeInTheDocument();
    expect(screen.getByTestId('trend-line')).toBeInTheDocument();
  });
});

describe('auto color mode', () => {
  it('pre-fills readable colors from any primary color', async () => {
    const { autoFill, contrast } = await import('../src/theme.js');
    for (const p of ['#3f51b5', '#ffeb3b', '#000000', '#ffffff', '#e91e63', '#009688']) {
      const d = autoFill({ primaryColor: p, backgroundColor: '#f5f6fa', surfaceColor: '#ffffff' });
      for (const bg of ['#ffffff', '#f5f6fa']) expect(contrast(d.secondaryColorLight, bg)).toBeGreaterThanOrEqual(4.5);
      for (const bg of ['#121317', '#1c1e24']) { expect(contrast(d.primaryColorDark, bg)).toBeGreaterThanOrEqual(4.5); expect(contrast(d.secondaryColor, bg)).toBeGreaterThanOrEqual(4.5); }
      expect(contrast(d.buttonTextLight, p)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(d.buttonTextDark, d.primaryColorDark)).toBeGreaterThanOrEqual(4.5);
    }
    expect(autoFill({ primaryColor: 'red', backgroundColor: '#fff', surfaceColor: '#fff' })).toEqual({});
  });
});

describe('reports navigation', () => {
  it('shows Reports in the top bar only with report.read, and not under Admin', async () => {
    const { default: Layout } = await import('../src/components/Layout.jsx');
    const a = renderApp(<Layout><div /></Layout>, { user: userWith(['report.read']) });
    expect(await screen.findByRole('link', { name: 'Reports' })).toHaveAttribute('href', '/reports');
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument(); a.unmount?.();
  });
  it('hides Reports from roles without the permission', async () => {
    const { default: Layout } = await import('../src/components/Layout.jsx');
    renderApp(<Layout><div /></Layout>, { user: userWith(['settings.read']) });
    expect(await screen.findByRole('link', { name: 'Admin' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Reports' })).not.toBeInTheDocument();
  });
});
