import { createSession } from '../src/auth/session.js';

export async function setSessionCookieForTest(userId, { stepup = true, stage = 'full' } = {}) {
  const s = await createSession(userId, { stage, stepup, mfaSatisfied: true });
  return { sid: s.id, csrf: s.csrf };
}
