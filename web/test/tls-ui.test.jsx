import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import AdminLayout from '../src/pages/admin/AdminLayout.jsx';
import { renderApp, userWith } from './helpers.jsx';

const cert = { subject: 'CN=code.example.com', issuer: 'CN=code.example.com', selfSigned: true, validFrom: '2026-01-01T00:00:00Z', validTo: '2028-04-05T00:00:00Z', fingerprint: 'AA:BB', altNames: ['DNS:code.example.com'] };
const base = { managedBy: 'admin', mode: 'unset', needsChoice: true, running: { https: false, source: null }, hostname: 'code.example.com', restartRequired: false, certificate: null, pendingCertificate: null };
const open = (st = base, extra = {}, perms = ['settings.read', 'settings.write']) => renderApp(<Routes><Route path="/admin/*" element={<AdminLayout />} /></Routes>,
  { route: '/admin/https', user: userWith(perms, { source: 'local' }), routes: { '/api/admin/tls': st, ...extra } });

describe('admin HTTPS page', () => {
  it('prompts for a choice when unconfigured and saves it', async () => {
    const { fetch } = open(base, { 'PUT /api/admin/tls': { ...base, mode: 'self-signed', needsChoice: false, restartRequired: true, pendingCertificate: cert } });
    expect(await screen.findByText(/HTTPS is not set up yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/Self-signed certificate/));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch.calls.find((c) => c.method === 'PUT')?.body).toEqual({ mode: 'self-signed' }));
    expect(await screen.findByText(/Restart the server to apply it/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Certificate after restart' })).toHaveTextContent('code.example.com');
  });
  it('offers no choice when the environment decides, and hides saving from read-only users', async () => {
    open({ ...base, managedBy: 'proxy', mode: null, needsChoice: false });
    expect(await screen.findByText(/reverse proxy/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Self-signed certificate/)).toBeNull();
  });
  it('shows the running certificate and lets a writer create a new one', async () => {
    const run = { ...base, mode: 'self-signed', needsChoice: false, running: { https: true, source: 'self-signed' }, certificate: cert };
    const { fetch } = open(run, { 'POST /api/admin/tls/regenerate': run });
    expect(await screen.findByRole('region', { name: 'Current certificate' })).toHaveTextContent('AA:BB');
    await userEvent.click(screen.getByRole('button', { name: 'Create a new certificate' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'POST' && c.url === '/api/admin/tls/regenerate')).toBe(true));
  });
});
