// Pure state machine for the tour. Statuses: loading -> idle | active; active -> done (skip/finish); done -> active (replay).
// `dir` is the way the user last moved (1 forward, -1 back), so skipping a missing step keeps going the same way.
export const initialState = { status: 'loading', index: 0, dir: 1 };

export function reducer(state, action, stepCount) {
  const last = stepCount - 1;
  switch (action.type) {
    case 'loaded':
      if (action.isCompleted) return { status: 'done', index: 0, dir: 1 };
      return { status: 'active', index: Math.min(Math.max(action.index || 0, 0), last), dir: 1 };
    case 'start': return { status: 'active', index: 0, dir: 1 };
    case 'next': return state.status === 'active' && state.index < last ? { ...state, index: state.index + 1, dir: 1 } : state;
    case 'back': return state.status === 'active' && state.index > 0 ? { ...state, index: state.index - 1, dir: -1 } : state;
    case 'end': return state.status === 'active' ? { status: 'done', index: 0, dir: 1 } : state;
    case 'unavailable': return { status: 'idle', index: 0, dir: 1 }; // couldn't load state: stay out of the user's way
    default: return state;
  }
}

export const routeMatches = (pathname, route) => !route || pathname === route || pathname.startsWith(`${route}/`);
