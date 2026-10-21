import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { deviceMode } from './theme.js';

const Ctx = createContext({ choice: 'system', setChoice: () => {}, mode: 'light' });
export const useColorMode = () => useContext(Ctx);

const MODES = ['system', 'light', 'dark'];
const stored = () => { try { const m = localStorage.getItem('mode'); return MODES.includes(m) ? m : null; } catch { return null; } };

// The user's own choice (System/Light/Dark, remembered in this browser) overrides the administrator's default mode.
// "system" tracks the device setting live; `mode` is always the resolved 'light' | 'dark'.
// `savedChoice` is the choice saved on the user's account (it follows them across browsers) and wins over this browser's copy;
// `onSave` persists a new choice to the account.
export function ColorModeProvider({ defaultChoice = 'system', savedChoice = null, onSave, children }) {
  const [own, setOwn] = useState(() => (MODES.includes(savedChoice) ? savedChoice : stored()));
  useEffect(() => { if (MODES.includes(savedChoice)) setOwn(savedChoice); }, [savedChoice]);
  const [device, setDevice] = useState(deviceMode);
  useEffect(() => {
    const q = window.matchMedia?.('(prefers-color-scheme: dark)'); if (!q) return undefined;
    const on = () => setDevice(q.matches ? 'dark' : 'light');
    q.addEventListener?.('change', on); return () => q.removeEventListener?.('change', on);
  }, []);
  const choice = own || (MODES.includes(defaultChoice) ? defaultChoice : 'system');
  const setChoice = useCallback((m) => { setOwn(m); try { localStorage.setItem('mode', m); } catch { /* not persisted */ } onSave?.(m); }, [onSave]);
  const mode = choice === 'system' ? device : choice;
  const value = useMemo(() => ({ choice, setChoice, mode }), [choice, setChoice, mode]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
