import crypto from 'node:crypto';
import { generateSecret, generateURI, verifySync } from 'otplib';
import QRCode from 'qrcode';
import { getKnex } from '../db/index.js';
import { trx } from '../db/dialect.js';
import { encrypt, decrypt, sha256 } from '../crypto.js';
import { getSettings } from '../settings.js';

export async function beginTotp(user, issuer) {
  const secret = generateSecret();
  await getKnex()('users').where({ id: user.id }).update({ totp_secret_enc: encrypt(secret), totp_confirmed: 0 });
  const uri = generateURI({ issuer, label: user.username || user.email || `user-${user.id}`, secret });
  return QRCode.toDataURL(uri).then((qr) => ({ secret, uri, qr }));
}

// Returns true once per time step (replay protection). The step is claimed with a conditional update, so two requests with the
// same code cannot both succeed even when they race.
export async function checkTotp(userId, code) {
  const k = getKnex();
  const u = await k('users').where({ id: userId }).first('totp_secret_enc', 'totp_last_step');
  if (!u?.totp_secret_enc || !/^\d{6}$/.test(String(code))) return false;
  const res = verifySync({ secret: decrypt(u.totp_secret_enc), token: String(code), epochTolerance: 30 });
  if (!res.valid || res.timeStep <= u.totp_last_step) return false;
  const claimed = await k('users').where({ id: userId }).where('totp_last_step', '<', res.timeStep).update({ totp_last_step: res.timeStep });
  return claimed === 1;
}

export async function confirmTotp(userId, code) {
  if (!(await checkTotp(userId, code))) return null;
  await getKnex()('users').where({ id: userId }).update({ totp_confirmed: 1, mfa_enrolled: 1 });
  return generateRecoveryCodes(userId);
}

export async function generateRecoveryCodes(userId) {
  const codes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex'));
  await trx(getKnex(), async (t) => {
    await t('recovery_codes').where({ user_id: userId }).del();
    await t('recovery_codes').insert(codes.map((c) => ({ user_id: userId, hash: sha256(c) })));
  });
  return codes;
}

export async function useRecoveryCode(userId, code) {
  const changed = await getKnex()('recovery_codes').where({ user_id: userId, hash: sha256(String(code).trim().toLowerCase()), used: 0 }).update({ used: 1 });
  return changed === 1;
}

export async function verifySecondFactor(userId, code) {
  const u = await getKnex()('users').where({ id: userId }).first('totp_confirmed');
  if (u?.totp_confirmed && await checkTotp(userId, code)) return 'totp';
  if (/^[0-9a-f]{10}$/i.test(String(code).trim()) && await useRecoveryCode(userId, code)) return 'recovery';
  return null;
}

export async function resetMfa(userId) {
  const k = getKnex();
  await trx(k, async (t) => {
    await t('users').where({ id: userId }).update({ totp_secret_enc: null, totp_confirmed: 0, mfa_enrolled: 0, totp_last_step: 0 });
    await t('recovery_codes').where({ user_id: userId }).del();
    await t('webauthn_credentials').where({ user_id: userId }).del();
    await t('sessions').where({ user_id: userId }).update({ revoked: 1 });
  });
}

export const enrollmentRequired = (user) => {
  if (user.mfa_enrolled) return false;
  const grace = getSettings('security').mfaGraceDays * 86400;
  return Math.floor(Date.now() / 1000) >= user.created_at + grace; // grace=0 => enrollment always required
};
