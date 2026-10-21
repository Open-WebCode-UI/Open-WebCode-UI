import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
fs.mkdirSync(dataDir, { recursive: true });

function loadKey() {
  if (process.env.ENCRYPTION_KEY) return crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest();
  const keyFile = path.join(dataDir, '.encryption-key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
}

export const config = {
  port: Number(process.env.PORT || 3000),
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  dataDir,
  dbFile: process.env.DB_FILE || path.join(dataDir, 'app.db'),
  encryptionKey: loadKey(),
  // Set ALLOW_INSECURE_DEV=1 to permit http cookies during local development.
  allowInsecureDev: process.env.ALLOW_INSECURE_DEV === '1',
  breakGlassPassword: process.env.BREAKGLASS_PASSWORD || '',
  // True when an administrator-managed server is serving plain HTTP (not chosen yet, or no HTTPS chosen).
  plainHttp: false,
  isProd: process.env.NODE_ENV === 'production',
};

export const cookieSecure = () => config.baseUrl.startsWith('https://');
