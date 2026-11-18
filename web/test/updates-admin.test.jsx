import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Updates from '../src/pages/admin/Updates.jsx';
import { renderApp, userWith, ADMIN } from './helpers.jsx';

afterEach(cleanup);

const status = (over = {}) => ({
  currentVersion: '1.0.0', runningVersion: '1.0.0', restartRequired: false, isCheckout: true, dirty: false,
  latest: '1.1.0', checkedAt: '2026-11-01T10:00:00.000Z', updateAvailable: true, updateType: 'minor', job: null, ...over,
});

describe('Admin > Updates', () => {
  it('shows the installed and newest versions and offers an install', async () => {
    renderApp(<Updates />, { user: userWith(ADMIN), routes: { 'GET /api/admin/update': status() } });
    expect(await screen.findByText('A minor update is available: 1.1.0.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install update' })).toBeEnabled();
  });

  it('checks for releases when asked', async () => {
    const { fetch } = renderApp(<Updates />, { user: userWith(ADMIN), routes: {
      'GET /api/admin/update': status({ latest: null, updateAvailable: false, checkedAt: null }),
      'POST /api/admin/update/check': status({ latest: '1.2.0' }),
    } });
    await userEvent.click(await screen.findByRole('button', { name: 'Check for updates' }));
    await waitFor(() => expect(fetch.calls.some((c) => c.method === 'POST' && c.url === '/api/admin/update/check')).toBe(true));
    expect(await screen.findByText('A minor update is available: 1.2.0.')).toBeInTheDocument();
  });

  it('starts the install and shows its progress log', async () => {
    const { fetch } = renderApp(<Updates />, { user: userWith(ADMIN), routes: {
      'GET /api/admin/update': status(),
      'POST /api/admin/update/apply': status({ job: { state: 'running', from: '1.0.0', to: '1.1.0', log: ['Fetching v1.1.0'], error: null, rolledBack: false } }),
    } });
    await userEvent.click(await screen.findByRole('button', { name: 'Install update' }));
    expect(await screen.findByText('Fetching v1.1.0')).toBeInTheDocument();
    expect(fetch.calls.some((c) => c.method === 'POST' && c.url === '/api/admin/update/apply')).toBe(true);
  });

  it('is read-only without settings.write, and says why when there is no checkout', async () => {
    renderApp(<Updates />, { user: userWith(['settings.read']), routes: {
      'GET /api/admin/update': status({ isCheckout: false, updateAvailable: false, latest: '1.0.0' }),
    } });
    expect(await screen.findByText(/not installed from a git checkout/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install update' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeEnabled();
  });

  it('tells the administrator to restart after an update', async () => {
    renderApp(<Updates />, { user: userWith(ADMIN), routes: {
      'GET /api/admin/update': status({ currentVersion: '1.1.0', runningVersion: '1.0.0', restartRequired: true, updateAvailable: false, latest: '1.1.0' }),
    } });
    expect(await screen.findByText(/Restart the server to run version 1.1.0/)).toBeInTheDocument();
  });
});
