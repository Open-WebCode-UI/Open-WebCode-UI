import { createSession } from '../src/auth/session.js';
export function setSessionCookieForTest(userId, { stepup = true, stage = 'full' } = {}) {
  const s = createSession(userId, { stage, stepup, mfaSatisfied: true });
  return { sid: s.id, csrf: s.csrf };
}
