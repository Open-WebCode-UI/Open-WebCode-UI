import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SetupWizard from '../src/components/SetupWizard.jsx';
import { renderApp, userWith, ALL, ADMIN } from './helpers.jsx';

const values = { appName: 'Acme Code', tagline: '', primaryColor: '#112233', defaultMode: 'system', memoryAllowed: true, coursesEnabled: true, userMcpAllowed: true, showSessionCost: false };
const state = (over = {}) => ({ completed: false, values, modelCount: 0, execMode: 'files_only', ...over });

describe('setup wizard', () => {
  it('does not appear for users who cannot change settings', async () => {
    const { fetch } = renderApp(<SetupWizard />, { user: userWith(ALL), routes: { '/api/admin/setup': state() } });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/let's set things up/i)).not.toBeInTheDocument();
    expect(fetch.calls.some((c) => c.url === '/api/admin/setup')).toBe(false);
  });

  it('does not appear once setup is completed', async () => {
    renderApp(<SetupWizard />, { user: userWith(ADMIN), routes: { '/api/admin/setup': state({ completed: true }) } });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/let's set things up/i)).not.toBeInTheDocument();
  });

  it('walks through the steps and submits the choices', async () => {
    const { fetch } = renderApp(<SetupWizard />, { user: userWith(ADMIN), routes: { '/api/admin/setup': state(), 'POST /api/admin/setup/complete': state({ completed: true }) } });
    const ui = userEvent.setup();
    await screen.findByText(/let's set things up/i);
    await ui.click(screen.getByRole('button', { name: 'Next' }));
    await ui.click(screen.getByRole('switch', { name: /Agent memory/ }));
    await ui.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText(/No AI model is connected/)).toBeInTheDocument();
    await ui.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(screen.queryByText(/let's set things up/i)).not.toBeInTheDocument());
    const post = fetch.calls.find((c) => c.method === 'POST' && c.url === '/api/admin/setup/complete');
    expect(post.body.choices).toMatchObject({ appName: 'Acme Code', memoryAllowed: false, coursesEnabled: true });
  });

  it('Skip setup sends skip and closes', async () => {
    const { fetch } = renderApp(<SetupWizard />, { user: userWith(ADMIN), routes: { '/api/admin/setup': state(), 'POST /api/admin/setup/complete': state({ completed: true }) } });
    await userEvent.click(await screen.findByRole('button', { name: 'Skip setup' }));
    await waitFor(() => expect(screen.queryByText(/let's set things up/i)).not.toBeInTheDocument());
    expect(fetch.calls.find((c) => c.method === 'POST').body).toEqual({ skip: true });
  });
});
