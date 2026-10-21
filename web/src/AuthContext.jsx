import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { get, post, setCsrf, setExpiredHandler, ApiError } from './api.js';

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, stage: null, config: null, expired: false });
  const signedIn = useRef(false);

  const refresh = useCallback(async () => {
    const config = await get('/api/public-config').catch(() => null);
    try {
      const me = await get('/api/auth/me');
      setCsrf(me.csrf);
      signedIn.current = true;
      setState({ loading: false, user: me.user, stage: me.stage, config, expired: false });
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) console.error(e);
      setCsrf('');
      signedIn.current = false;
      setState((s) => ({ loading: false, user: null, stage: null, config, expired: s.expired && s.user === null }));
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  // The session ended while the user was signed in (idle too long, or signed out elsewhere): go back to the sign-in page, with a note.
  useEffect(() => {
    setExpiredHandler(() => {
      if (!signedIn.current) return;
      signedIn.current = false; setCsrf('');
      setState((s) => ({ ...s, user: null, stage: null, expired: true }));
    });
    // Coming back to the tab after a long absence: check right away instead of waiting for the first click to fail.
    const onVisible = () => { if (document.visibilityState === 'visible' && signedIn.current) get('/api/auth/me').catch(() => {}); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { setExpiredHandler(null); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  const value = useMemo(() => ({
    ...state, refresh,
    can: (perm) => !!state.user?.permissions?.includes(perm),
    logout: async () => { signedIn.current = false; await post('/api/auth/logout').catch(() => {}); await refresh(); },
  }), [state, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
