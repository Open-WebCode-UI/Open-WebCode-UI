import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import Help from '../src/pages/Help.jsx';
import Profile from '../src/pages/Profile.jsx';
import AdminLayout from '../src/pages/admin/AdminLayout.jsx';
import Chat from '../src/pages/Chat.jsx';
import Login from '../src/pages/Login.jsx';
import Terms from '../src/pages/Terms.jsx';
import { layoutStore } from '../src/components/../layoutStore.js';
import { renderApp, userWith, ALL, ADMIN, PUBLIC } from './helpers.jsx';

vi.mock('@monaco-editor/react', () => ({ default: () => <div data-testid="monaco" />, DiffEditor: () => <div /> }));
vi.mock('@xterm/xterm', () => ({ Terminal: class { loadAddon() {} open() {} write() {} onData() { return { dispose() {} }; } dispose() {} } }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
const { default: IDE } = await import('../src/pages/IDE.jsx');

const withContact = { ...PUBLIC, general: { ...PUBLIC.general, contactName: 'Pat Admin', contactEmail: 'pat@acme.test' } };
const noContact = { ...PUBLIC, general: { ...PUBLIC.general, helpdeskEmail: '', helpdeskPhone: '', helpdeskUrl: '', helpdeskHours: '' } };
const footer = () => screen.findByRole('contentinfo', { name: 'Contact information' });
beforeEach(() => { localStorage.clear(); layoutStore.forgetForTests(); });

describe('contact footer on Profile, Help and Admin', () => {
  it('Profile shows the contact details at the end of the page', async () => {
    renderApp(<Routes><Route path="/profile/*" element={<Profile />} /></Routes>, { route: '/profile/account', user: userWith(ALL), config: withContact, routes: { '/api/profile/preferences': {} } });
    const f = await footer();
    expect(within(f).getByText(/Pat Admin/)).toBeInTheDocument();
    expect(within(f).getByRole('link', { name: 'pat@acme.test' })).toHaveAttribute('href', 'mailto:pat@acme.test');
    expect(within(f).getByRole('link', { name: 'Helpdesk portal' })).toHaveAttribute('href', 'https://help.acme.test');
  });
  it('Help shows it after the topic', async () => {
    renderApp(<Routes><Route path="/help/:topic?" element={<Help />} /></Routes>, { route: '/help', user: userWith(ALL), config: withContact });
    const f = await footer(); const topic = screen.getByRole('heading', { level: 1 });
    expect(topic.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('Admin shows it', async () => {
    renderApp(<Routes><Route path="/admin/*" element={<AdminLayout />} /></Routes>, { route: '/admin/general', user: userWith(ADMIN), config: withContact, routes: { '/api/admin/general': { ...withContact.general } } });
    expect(within(await footer()).getByText(/Pat Admin/)).toBeInTheDocument();
  });
  it('shows nothing when no contact information is set', async () => {
    renderApp(<Routes><Route path="/profile/*" element={<Profile />} /></Routes>, { route: '/profile/account', user: userWith(ALL), config: noContact, routes: { '/api/profile/preferences': {} } });
    await screen.findByRole('heading', { name: 'Account' }); expect(screen.queryByRole('contentinfo')).toBeNull();
  });
});

describe('contact information on Chat and in the Agent', () => {
  it('Chat shows it at the bottom of the chat list', async () => {
    renderApp(<Chat />, { user: userWith(ALL), config: withContact, routes: { '/api/models': { models: [], defaults: {} }, '/api/conversations': [], '/api/skills': [] } });
    const f = await footer(); const list = await screen.findByRole('list', { name: /chats/ });
    expect(list.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(f).getByRole('link', { name: 'pat@acme.test' })).toBeInTheDocument();
  });
  const workspace = () => renderApp(<IDE />, { user: userWith(ALL), config: withContact, routes: { '/api/projects': [{ id: 1, name: 'demo' }], '/api/projects/1/tree': [], '/api/projects/1/checkpoints': [], '/api/models': { models: [], defaults: {} }, '/api/skills': [], '/api/sessions': [], '/api/terminal/status': { enabled: false }, '/api/agent/status': { connection: { status: 'connected', signedInVia: 'Local account', mfaVerified: false, sessionStartedAt: 1, sessionExpiresAt: 2, model: null }, server: { name: 'Acme', url: 'http://x', secure: false, shell: 'files only' }, user: { displayName: 'Dee', roles: [] }, project: null, features: { mcpServers: 0, memory: [] } } } });
  it('the Contact and Platform status panes exist but are hidden by default', async () => {
    workspace(); await screen.findByTestId('pane-chat');
    expect(screen.getByTestId('pane-contact')).toHaveAttribute('data-hidden'); expect(screen.getByTestId('pane-status')).toHaveAttribute('data-hidden');
  });
  it('the Layout menu opens them, and Platform status loads the status', async () => {
    workspace(); await screen.findByTestId('pane-chat');
    layoutStore.toggle('contact'); layoutStore.toggle('status');
    await waitFor(() => expect(screen.getByTestId('pane-contact')).not.toHaveAttribute('data-hidden'));
    expect(within(screen.getByTestId('pane-contact')).getByText(/pat@acme.test/)).toBeInTheDocument();
    expect(await within(screen.getByTestId('pane-status')).findByTestId('status-card')).toBeInTheDocument();
  });
});

describe('terms and acceptable use page', () => {
  const withTerms = { ...noContact, general: { ...noContact.general, termsNotice: 'Be kind.\nNo abuse.' } };
  it('is linked from the footer when terms are set, even with no contact details', async () => {
    renderApp(<Routes><Route path="/profile/*" element={<Profile />} /></Routes>, { route: '/profile/account', user: userWith(ALL), config: withTerms, routes: { '/api/profile/preferences': {} } });
    expect(within(await footer()).getByRole('link', { name: 'Terms and acceptable use' })).toHaveAttribute('href', '/terms');
  });
  it('is linked from the sign-in page instead of showing the text inline', async () => {
    renderApp(<Login />, { config: withTerms });
    expect(await screen.findByRole('link', { name: 'terms and acceptable use' })).toHaveAttribute('href', '/terms');
    expect(screen.queryByText(/Be kind/)).toBeNull();
  });
  it('the page shows the text', async () => {
    renderApp(<Routes><Route path="/terms" element={<Terms standalone />} /></Routes>, { route: '/terms', config: withTerms });
    expect(await screen.findByRole('heading', { name: 'Terms and acceptable use' })).toBeInTheDocument();
    expect(screen.getByText(/No abuse/)).toBeInTheDocument();
  });
  it('shows no link without terms', async () => {
    renderApp(<Login />, { config: noContact });
    await screen.findByRole('button', { name: 'Sign in' }); expect(screen.queryByRole('link', { name: /terms/i })).toBeNull();
  });
});
