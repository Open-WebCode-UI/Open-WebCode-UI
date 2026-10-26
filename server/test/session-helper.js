import { getDb } from '../src/db/index.js';
import { randomToken } from '../src/crypto.js';

// Test-only and synchronous, because the test helpers' login() is called without await from about 200 places. It writes the same row
// as createSession() (auth/session.js) on the legacy connection, which the Knex handle shares. Remove it when login() becomes async.
export function setSessionCookieForTest(userId, { stepup = true, stage = 'full' } = {}) {
  const id = randomToken(32), csrf = randomToken(24), t = Math.floor(Date.now() / 1000);
  getDb().prepare(`INSERT INTO sessions (id,user_id,csrf,stage,created_at,last_seen,auth_time,stepup_at,mfa_satisfied,ip,ua)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, csrf, stage, t, t, t, stepup ? t : 0, 1, null, '');
  return { sid: id, csrf };
}
