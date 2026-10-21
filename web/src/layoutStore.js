import { useSyncExternalStore } from 'react';
import { loadLayout, hasSavedLayout, applyPreset, resetLayout, hidePane, showPane, visiblePanes } from './components/ide/layout.js';

// The workspace layout is shared between the workspace itself and the Layout menu in the app header, so it lives here
// rather than inside the workspace component. (IdeLayout saves it to the browser a moment after it changes.)
let state = null;
let noShell = false; // shell access is off: the default layout leaves the terminal hidden (it can still be shown from the Layout menu)
const fresh = () => (noShell ? hidePane(resetLayout(), 'terminal') : resetLayout());
const subs = new Set();
const notify = () => subs.forEach((f) => f());
const get = () => (state ??= (hasSavedLayout() || !noShell ? loadLayout() : fresh()));
const set = (next) => { state = typeof next === 'function' ? next(get()) : next; notify(); };

export const layoutStore = {
  get, set,
  // Called before the workspace first renders; only affects a layout the user has not saved yet, and Reset layout.
  configure: ({ shellEnabled }) => { noShell = shellEnabled === false; },
  subscribe: (f) => { subs.add(f); return () => subs.delete(f); },
  preset: (key) => set((l) => applyPreset(l, key)),
  reset: () => set(fresh()),
  toggle: (pane) => set((l) => (visiblePanes(l).includes(pane) ? hidePane(l, pane) : showPane(l, pane))),
  forgetForTests: () => { state = null; noShell = false; notify(); },
};
export const useLayout = () => [useSyncExternalStore(layoutStore.subscribe, get), set];
