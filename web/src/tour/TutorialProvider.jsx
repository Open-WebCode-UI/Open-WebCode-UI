import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { get, post } from '../api.js';
import { useAuth } from '../AuthContext.jsx';
import { STEPS } from './steps.js';
import { initialState, reducer, routeMatches } from './machine.js';

const Ctx = createContext(null);
export const useTutorial = () => useContext(Ctx);

export function TutorialProvider({ children, script = STEPS }) {
  const { can } = useAuth();
  const steps = useMemo(() => script.filter((s) => !s.requires || can(s.requires)), [script, can]);
  const [state, dispatch] = useReducer((s, a) => reducer(s, a, steps.length), initialState);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const queue = useRef(Promise.resolve()); // writes go out in order, so a late progress update can never overtake "complete"
  const persist = useCallback((url, body) => { queue.current = queue.current.then(() => post(url, body)).catch(() => {}); }, []);

  // Resume / auto-start: a user who has not finished the tour gets it on entering the app, at the step they left off.
  useEffect(() => {
    let live = true;
    get('/api/user/onboarding').then((s) => live && dispatch({ type: 'loaded', isCompleted: s.isCompleted, index: s.lastStepIndex }), () => live && dispatch({ type: 'unavailable' }));
    return () => { live = false; };
  }, []);

  const active = state.status === 'active';
  const step = active ? steps[state.index] : null;
  const isLast = state.index === steps.length - 1;

  const go = useCallback((type, index) => { dispatch({ type }); persist('/api/user/onboarding/update', { stepIndex: index }); }, [persist]);
  const end = useCallback(() => { dispatch({ type: 'end' }); persist('/api/user/onboarding/complete'); }, [persist]);

  // A navigation step finishes when the user arrives (by clicking its target or any other way) from somewhere else.
  const prevPath = useRef(pathname);
  useEffect(() => {
    const moved = prevPath.current !== pathname; prevPath.current = pathname;
    if (moved && step?.navigate && routeMatches(pathname, step.navigate)) go('next', state.index + 1);
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = useMemo(() => ({
    steps, step, index: state.index, total: steps.length, isActive: active, isCompleted: state.status === 'done', isLast,
    onRoute: !step || routeMatches(pathname, step.route),
    atDestination: !!step?.navigate && routeMatches(pathname, step.navigate),
    // The step's element is not on screen (and the step is optional): move on in the direction the user was heading.
    skipMissing: () => (state.dir < 0 && state.index > 0 ? go('back', state.index - 1) : isLast ? end() : go('next', state.index + 1)),
    start: () => { dispatch({ type: 'start' }); persist('/api/user/onboarding/update', { stepIndex: 0, restart: true }); },
    back: () => { if (state.index > 0) go('back', state.index - 1); },
    // On a navigation step "Next" takes the user there itself (keyboard-friendly alternative to clicking the target).
    next: () => {
      if (step?.navigate && !routeMatches(pathname, step.navigate)) navigate(step.navigate);
      else if (isLast) end();
      else go('next', state.index + 1);
    },
    gotoStepRoute: () => step?.route && navigate(step.route),
    skip: end, finish: end,
  }), [steps, step, state, active, isLast, pathname, navigate, go, end, persist]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
