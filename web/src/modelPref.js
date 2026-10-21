// Remembers which model the user picked last, so the pickers stop snapping back to the top of the list.
const key = (kind) => `lastModel:${kind}`;
export const lastModel = (kind) => { try { const v = Number(localStorage.getItem(key(kind))); return v || null; } catch { return null; } };
export const rememberModel = (kind, id) => { try { if (id) localStorage.setItem(key(kind), String(id)); } catch { /* storage may be unavailable */ } };
// First candidate that is still an available model; otherwise the first model in the list.
export const pickModel = (models, ...candidates) => candidates.find((c) => c && models.some((m) => m.id === c)) ?? models[0]?.id ?? '';

// Whether the user wants the model to think (when it supports it). On by default.
export const thinkingPref = () => { try { return localStorage.getItem('thinkingEnabled') !== '0'; } catch { return true; } };
export const effortPref = () => { try { const v = localStorage.getItem('effortLevel'); return ['quick', 'balanced', 'thorough'].includes(v) ? v : 'balanced'; } catch { return 'balanced'; } };
export const rememberEffort = (v) => { try { localStorage.setItem('effortLevel', v); } catch { /* storage may be unavailable */ } };
export const rememberThinking = (on) => { try { localStorage.setItem('thinkingEnabled', on ? '1' : '0'); } catch { /* storage may be unavailable */ } };
