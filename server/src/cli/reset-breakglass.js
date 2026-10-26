// Operator recovery: sets a new break-glass password (and optionally clears MFA). Requires shell access to the server.
//   npm run reset-breakglass -w server              -> random password printed once
//   BREAKGLASS_PASSWORD='...' npm run reset-breakglass -w server
//   npm run reset-breakglass -w server -- --reset-mfa
import { randomToken } from '../crypto.js';
import { getKnex } from '../db/index.js';
import { audit } from '../audit.js';
import { createLocalUser, hashPassword, checkPassword } from '../users.js';
import { resetMfa } from '../auth/mfa.js';

export async function resetBreakGlass({ password, resetMfaToo = false, username = 'breakglass' } = {}) {
  const k = getKnex();
  const pw = password || randomToken(15);
  const u = await k('users').where({ source: 'local', username }).first();
  if (!u) {
    const id = await createLocalUser({ username, password: pw, roles: ['administrator'], isBreakGlass: true, mustChange: !password });
    await audit(null, 'cli.breakglass_created', username);
    return { password: pw, created: true, id };
  }
  checkPassword(pw, username);
  await k('users').where({ id: u.id }).update({
    password_hash: hashPassword(pw), must_change_password: password ? 0 : 1, disabled: 0, is_break_glass: 1, failed_attempts: 0, lockouts: 0, locked_until: 0,
  });
  const admin = await k('roles').where({ name: 'administrator' }).first('id');
  await k('user_roles').insert({ user_id: u.id, role_id: admin.id, source: 'manual' }).onConflict(['user_id', 'role_id', 'source']).ignore();
  await k('sessions').where({ user_id: u.id }).update({ revoked: 1 });
  if (resetMfaToo) await resetMfa(u.id);
  await audit(null, 'cli.breakglass_reset', username, { mfaReset: resetMfaToo });
  return { password: pw, created: false, id: u.id };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { config } = await import('../config.js');
  const { initDb } = await import('../db/index.js');
  await initDb();
  const r = await resetBreakGlass({ password: config.breakGlassPassword, resetMfaToo: process.argv.includes('--reset-mfa') });
  console.log(`\nBreak-glass account ${r.created ? 'created' : 'reset'} (database: ${config.dbFile}).`);
  console.log('  username: breakglass');
  console.log(config.breakGlassPassword ? '  password: (the BREAKGLASS_PASSWORD you supplied)' : `  password: ${r.password}   (shown once; change required at next sign-in)`);
  console.log('  Sign in at /login/local. MFA is kept unless you passed --reset-mfa.\n');
}
