import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Profile from '../src/pages/Profile.jsx';
import { renderApp, userWith, ALL } from './helpers.jsx';
import { ColorModeProvider } from '../src/colorMode.jsx';
import { buildTheme } from '../src/theme.js';

afterEach(cleanup);
const PREFS = { colorMode: null, fontScale: 100, reduceMotion: false, highContrast: false, underlineLinks: false };
const local = (over = {}) => userWith(ALL, { source: 'local', firstName: 'Dee', lastName: 'Veloper', mfaEnrolled: true, webauthnCount: 0, preferences: PREFS, ...over });
const open = (user, routes = {}) => renderApp(<Profile />, { route: '/profile/account', user, routes: { '/api/auth/sessions': [], ...routes } });
const last = (f, method, url) => f.calls.filter((c) => c.method === method && String(c.url).startsWith(url)).at(-1);

describe('profile → Account settings', () => {
  it('edits the name; the email is shown but read-only', async () => {
    const { fetch } = open(local(), { 'PUT /api/profile/account': { user: {} } });
    const email = await screen.findByLabelText('Email');
    expect(email).toBeDisabled(); expect(email).toHaveValue('d@x.test');
    const save = screen.getByRole('button', { name: 'Save name' });
    expect(save).toBeDisabled(); // nothing changed yet
    await userEvent.clear(screen.getByLabelText('First name')); await userEvent.type(screen.getByLabelText('First name'), 'Dana');
    await userEvent.click(save);
    await waitFor(() => expect(last(fetch, 'PUT', '/api/profile/account')).toBeTruthy());
    expect(last(fetch, 'PUT', '/api/profile/account').body).toEqual({ firstName: 'Dana', lastName: 'Veloper' }); // never sends email
  });
  it('single sign-on users cannot edit their name', async () => {
    open(local({ source: 'saml' }));
    expect(await screen.findByLabelText('First name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save name' })).toBeNull();
  });
  it('saves accessibility preferences to the account', async () => {
    const { fetch } = open(local(), { 'PUT /api/profile/preferences': PREFS });
    await userEvent.click(await screen.findByRole('switch', { name: /Reduce motion/ }));
    await waitFor(() => expect(last(fetch, 'PUT', '/api/profile/preferences')).toBeTruthy());
    expect(last(fetch, 'PUT', '/api/profile/preferences').body).toEqual({ reduceMotion: true });
  });
  it('saves the color mode to the account', async () => {
    const calls = [];
    renderApp(<ColorModeProvider savedChoice="light" onSave={(m) => calls.push(m)}><Profile /></ColorModeProvider>, { route: '/profile/account', user: local(), routes: { '/api/auth/sessions': [] } });
    expect(await screen.findByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true'); // the account's saved choice wins
    await userEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(calls).toEqual(['dark']);
  });
  it('shows MFA status on the Security page', async () => {
    renderApp(<Profile />, { route: '/profile/security', user: local({ webauthnCount: 2 }), routes: { '/api/auth/sessions': [] } });
    expect(await screen.findByTestId('mfa-status')).toHaveTextContent('Authenticator app is set up; 2 security keys registered.');
  });
});

describe('theme accessibility options', () => {
  it('scales text, and applies high contrast, underlined links, and reduced motion', () => {
    const t = buildTheme(undefined, 'light', { fontScale: 130, highContrast: true, reduceMotion: true, underlineLinks: true });
    expect(t.typography.fontSize).toBeCloseTo(18.2);
    expect(t.palette.text.primary).toBe('#000000');
    expect(t.transitions.create()).toBe('none');
    expect(t.components.MuiLink.defaultProps.underline).toBe('always');
  });
  it('is unchanged by default', () => {
    const t = buildTheme(undefined, 'light');
    expect(t.typography.fontSize).toBe(14); expect(t.components.MuiLink).toBeUndefined();
  });
});
