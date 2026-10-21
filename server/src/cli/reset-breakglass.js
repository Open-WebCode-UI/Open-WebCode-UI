// Operator recovery: sets a new break-glass password (and optionally clears MFA). Requires shell access to the server.
//   npm run reset-breakglass -w server              -> random password printed once
//   BREAKGLASS_PASSWORD='...' npm run reset-breakglass -w server
//   npm run reset-breakglass -w server -- --reset-mfa
import { randomToken } from '../crypto.js';
import { getDb } from '../db/index.js';
import { audit } from '../audit.js';
import { createLocalUser, hashPassword, checkPassword } from '../users.js';
import { resetMfa } from '../auth/mfa.js';

export function resetBreakGlass({ password, resetMfaToo = false, username = 'breakglass' } = {}) {
  const db = getDb();
  const pw = password || randomToken(15);
  let u = db.prepare("SELECT * FROM users WHERE source='local' AND username=?").get(username);
  if (!u) {
    const id = createLocalUser({ username, password: pw, roles: ['administrator'], isBreakGlass: true, mustChange: !password });
    audit(null, 'cli.breakglass_created', username);
    return { password: pw, created: true, id };
  }
  checkPassword(pw, username);
  db.prepare('UPDATE users SET password_hash=?, must_change_password=?, disabled=0, is_break_glass=1, failed_attempts=0, lockouts=0, locked_until=0 WHERE id=?')
    .run(hashPassword(pw), password ? 0 : 1, u.id);
  const admin = db.prepare("SELECT id FROM roles WHERE name='administrator'").get().id;
  db.prepare("INSERT OR IGNORE INTO user_roles (user_id, role_id, source) VALUES (?,?,'manual')").run(u.id, admin);
  db.prepare('UPDATE sessions SET revoked=1 WHERE user_id=?').run(u.id);
  if (resetMfaToo) resetMfa(u.id);
  audit(null, 'cli.breakglass_reset', username, { mfaReset: resetMfaToo });
  return { password: pw, created: false, id: u.id };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { config } = await import('../config.js');
  const { initDb } = await import('../db/index.js');
  initDb(config.dbFile);
  const r = resetBreakGlass({ password: config.breakGlassPassword, resetMfaToo: process.argv.includes('--reset-mfa') });
  console.log(`\nBreak-glass account ${r.created ? 'created' : 'reset'} (database: ${config.dbFile}).`);
  console.log('  username: breakglass');
  console.log(config.breakGlassPassword ? '  password: (the BREAKGLASS_PASSWORD you supplied)' : `  password: ${r.password}   (shown once; change required at next sign-in)`);
  console.log('  Sign in at /login/local. MFA is kept unless you passed --reset-mfa.\n');
}
