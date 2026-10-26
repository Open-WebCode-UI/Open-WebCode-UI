import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
fs.mkdirSync(dataDir, { recursive: true });

function loadKey() {
  if (process.env.ENCRYPTION_KEY) return crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest();
  const keyFile = path.join(dataDir, '.encryption-key');
  if (!fs.existsSync(keyFile)) {
    // Several processes can start at once (the first run, or parallel tests). The key is written in full under a temporary name and
    // hard-linked into place, which fails if another process got there first, so nobody reads a half-written key.
    const tmp = `${keyFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    try { fs.linkSync(tmp, keyFile); } catch (e) { if (e.code !== 'EEXIST') throw e; } finally { fs.rmSync(tmp, { force: true }); }
  }
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
