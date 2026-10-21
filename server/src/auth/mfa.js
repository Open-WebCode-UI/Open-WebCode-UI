import crypto from 'node:crypto';
import { generateSecret, generateURI, verifySync } from 'otplib';
import QRCode from 'qrcode';
import { getDb } from '../db/index.js';
import { encrypt, decrypt, sha256 } from '../crypto.js';
import { getSettings } from '../settings.js';

export function beginTotp(user, issuer) {
  const secret = generateSecret();
  getDb().prepare('UPDATE users SET totp_secret_enc=?, totp_confirmed=0 WHERE id=?').run(encrypt(secret), user.id);
  const uri = generateURI({ issuer, label: user.username || user.email || `user-${user.id}`, secret });
  return QRCode.toDataURL(uri).then((qr) => ({ secret, uri, qr }));
}

// Returns true once per time step (replay protection).
export function checkTotp(userId, code) {
  const db = getDb();
  const u = db.prepare('SELECT totp_secret_enc, totp_last_step FROM users WHERE id=?').get(userId);
  if (!u?.totp_secret_enc || !/^\d{6}$/.test(String(code))) return false;
  const res = verifySync({ secret: decrypt(u.totp_secret_enc), token: String(code), epochTolerance: 30 });
  if (!res.valid || res.timeStep <= u.totp_last_step) return false;
  db.prepare('UPDATE users SET totp_last_step=? WHERE id=?').run(res.timeStep, userId);
  return true;
}

export function confirmTotp(userId, code) {
  if (!checkTotp(userId, code)) return null;
  getDb().prepare('UPDATE users SET totp_confirmed=1, mfa_enrolled=1 WHERE id=?').run(userId);
  return generateRecoveryCodes(userId);
}

export function generateRecoveryCodes(userId) {
  const db = getDb();
  db.prepare('DELETE FROM recovery_codes WHERE user_id=?').run(userId);
  const codes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex'));
  for (const c of codes) db.prepare('INSERT INTO recovery_codes (user_id, hash) VALUES (?,?)').run(userId, sha256(c));
  return codes;
}

export function useRecoveryCode(userId, code) {
  const r = getDb().prepare('UPDATE recovery_codes SET used=1 WHERE user_id=? AND hash=? AND used=0')
    .run(userId, sha256(String(code).trim().toLowerCase()));
  return r.changes === 1;
}

export function verifySecondFactor(userId, code) {
  const u = getDb().prepare('SELECT totp_confirmed FROM users WHERE id=?').get(userId);
  if (u?.totp_confirmed && checkTotp(userId, code)) return 'totp';
  if (/^[0-9a-f]{10}$/i.test(String(code).trim()) && useRecoveryCode(userId, code)) return 'recovery';
  return null;
}

export function resetMfa(userId) {
  const db = getDb();
  db.prepare('UPDATE users SET totp_secret_enc=NULL, totp_confirmed=0, mfa_enrolled=0, totp_last_step=0 WHERE id=?').run(userId);
  db.prepare('DELETE FROM recovery_codes WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM webauthn_credentials WHERE user_id=?').run(userId);
  db.prepare('UPDATE sessions SET revoked=1 WHERE user_id=?').run(userId);
}

export const enrollmentRequired = (user) => {
  if (user.mfa_enrolled) return false;
  const grace = getSettings('security').mfaGraceDays * 86400;
  return Math.floor(Date.now() / 1000) >= user.created_at + grace; // grace=0 => enrollment always required
};
