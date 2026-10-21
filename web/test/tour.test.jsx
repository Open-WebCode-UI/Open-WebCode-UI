import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route, useLocation } from 'react-router-dom';
import Layout from '../src/components/Layout.jsx';
import Profile from '../src/pages/Profile.jsx';
import Help from '../src/pages/Help.jsx';
import { TutorialProvider } from '../src/tour/TutorialProvider.jsx';
import TourRoot from '../src/tour/TourRoot.jsx';
import { STEPS } from '../src/tour/steps.js';
import { reducer, initialState, routeMatches } from '../src/tour/machine.js';
import { renderApp, userWith, ALL } from './helpers.jsx';

// jsdom has no layout engine: give tour targets a size so they count as visible.
beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
    return this.hasAttribute?.('data-tour') ? { top: 10, left: 10, width: 100, height: 30, right: 110, bottom: 40, x: 10, y: 10, toJSON() {} } : { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} };
  });
});

describe('tour state machine', () => {
  const r = (s, a) => reducer(s, a, 5);
  it('auto-starts at the saved step, clamped to the script', () => {
    expect(r(initialState, { type: 'loaded', isCompleted: false, index: 2 })).toEqual({ status: 'active', index: 2, dir: 1 });
    expect(r(initialState, { type: 'loaded', isCompleted: false, index: 99 }).index).toBe(4);
  });
  it('stays finished for a user who completed it', () => { expect(r(initialState, { type: 'loaded', isCompleted: true, index: 3 }).status).toBe('done'); });
  it('moves within bounds and ends', () => {
    const a = { status: 'active', index: 0, dir: 1 };
    expect(r(a, { type: 'back' })).toBe(a);
    expect(r(a, { type: 'next' }).index).toBe(1);
    expect(r({ status: 'active', index: 4 }, { type: 'next' }).index).toBe(4);
    expect(r({ status: 'active', index: 2, dir: 1 }, { type: 'back' }).dir).toBe(-1);
    expect(r(a, { type: 'end' }).status).toBe('done');
  });
  it('replays from step 1', () => { expect(r({ status: 'done', index: 0 }, { type: 'start' })).toEqual({ status: 'active', index: 0, dir: 1 }); });
  it('matches routes by path segment', () => {
    expect(routeMatches('/profile/security', '/profile')).toBe(true);
    expect(routeMatches('/profiles', '/profile')).toBe(false);
    expect(routeMatches('/anything', undefined)).toBe(true);
  });
});

describe('the script', () => {
  it('has unique steps and only plain-text targets', () => {
    expect(new Set(STEPS.map((s) => s.id)).size).toBe(STEPS.length);
    for (const s of STEPS) expect(s.target, s.id).toMatch(/^[a-z-]+$/);
  });
  it('covers every workspace panel', () => {
    for (const p of ['explorer', 'sessions', 'editor', 'chat', 'terminal']) expect(STEPS.map((s) => s.target), p).toContain(`pane-${p}`);
  });
});

const Where = () => <span data-testid="where">{useLocation().pathname}</span>;
function app({ state, route = '/help' }) {
  const saves = [];
  const record = (url) => (init) => { saves.push({ url, body: JSON.parse(init.body) }); return {}; };
  const utils = renderApp(
    <TutorialProvider><Layout><Routes><Route path="/" element={<div data-tour="pane-explorer">Explorer</div>} /><Route path="/profile/*" element={<Profile />} /><Route path="/help/:topic?" element={<Help />} /></Routes></Layout><TourRoot /><Where /></TutorialProvider>,
    { user: userWith(ALL), route, routes: {
      'GET /api/user/onboarding': state,
      'POST /api/user/onboarding/update': record('update'), 'POST /api/user/onboarding/complete': record('complete'),
      '/api/profile/prompts': { overrides: {}, defaults: {} }, '/api/skills': [], '/api/auth/sessions': [],
    } },
  );
  return { ...utils, saves };
}
const lastSave = (saves, kind) => saves.filter((s) => s.url === kind).at(-1);

describe('tour in the app', () => {
  it('shows the first step to a new user, steps forward, and saves progress', async () => {
    const { saves } = app({ state: { isCompleted: false, lastStepIndex: 0 } });
    const tip = await screen.findByRole('dialog', { name: /open the agent workspace/i });
    expect(tip).toHaveTextContent('1 of 10');
    await userEvent.click(screen.getByRole('button', { name: 'Take me there' }));
    expect(await screen.findByRole('dialog', { name: /explorer/i })).toBeInTheDocument();
    await waitFor(() => expect(lastSave(saves, 'update').body).toEqual({ stepIndex: 1 }));
  });

  it('does not appear for a user who finished it', async () => {
    const { fetch } = app({ state: { isCompleted: true, lastStepIndex: 0 } });
    await waitFor(() => expect(fetch.calls.some((c) => c.url === '/api/user/onboarding')).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('resumes where the user left off', async () => {
    app({ state: { isCompleted: false, lastStepIndex: 5 } });
    expect(await screen.findByRole('dialog', { name: /plan first, then act/i })).toBeInTheDocument();
  });

  it('follows a navigation step to another page and shows the next tooltip there', async () => {
    app({ state: { isCompleted: false, lastStepIndex: 0 } });
    expect(await screen.findByRole('dialog', { name: /open the agent workspace/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Agent' })); // click the highlighted target itself
    expect(await screen.findByRole('dialog', { name: /explorer/i })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/');
  });

  it('"Take me there" navigates for keyboard users', async () => {
    app({ state: { isCompleted: false, lastStepIndex: 0 } });
    await userEvent.click(await screen.findByRole('button', { name: 'Take me there' }));
    expect(await screen.findByRole('dialog', { name: /explorer/i })).toBeInTheDocument();
  });

  it('describes the agent panels on the workspace page and sends you there from elsewhere', async () => {
    app({ state: { isCompleted: false, lastStepIndex: 1 }, route: '/help' });
    const tip = await screen.findByRole('dialog', { name: /explorer/i });
    expect(tip).toHaveTextContent('another page');
    await userEvent.click(screen.getByRole('button', { name: 'Go there' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/');
  });

  it('passes over optional steps whose panel is not on screen', async () => {
    app({ state: { isCompleted: false, lastStepIndex: 6 }, route: '/' });
    expect(await screen.findByRole('dialog', { name: /make the workspace yours/i }, { timeout: 4000 })).toBeInTheDocument();
  }, 8000);

  it('Skip records completion', async () => {
    const { saves } = app({ state: { isCompleted: false, lastStepIndex: 0 } });
    await userEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(saves.some((s) => s.url === 'complete')).toBe(true);
  });

  it('Finish on the last step records completion', async () => {
    const { saves } = app({ state: { isCompleted: false, lastStepIndex: 9 } });
    await userEvent.click(await screen.findByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(saves.some((s) => s.url === 'complete')).toBe(true));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Replay on the Profile page restarts from step 1 and tells the server', async () => {
    const { saves } = app({ state: { isCompleted: true, lastStepIndex: 0 }, route: '/profile' });
    await userEvent.click(await screen.findByRole('button', { name: 'Replay tutorial' }));
    expect(await screen.findByRole('dialog', { name: /open the agent workspace/i })).toHaveTextContent('1 of 10');
    await waitFor(() => expect(lastSave(saves, 'update').body).toEqual({ stepIndex: 0, restart: true }));
  });
});
