import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { decrypt, encrypt } from '../crypto.js';

export const DB_CLIENTS = ['sqlite', 'postgres', 'mariadb'];
const DEFAULT_PORT = { postgres: 5432, mariadb: 3306 };
const ALIASES = { sqlite3: 'sqlite', pg: 'postgres', postgresql: 'postgres', mysql: 'mariadb' };
const URL_CLIENT = { 'postgres:': 'postgres', 'postgresql:': 'postgres', 'mysql:': 'mariadb', 'mariadb:': 'mariadb' };

const bootstrapFile = (dataDir = config.dataDir) => path.join(dataDir, 'db.json');
const normalizeClient = (c) => { const v = String(c || '').toLowerCase(); return ALIASES[v] || v; };

// The database cannot be chosen through the settings table (it lives in the database), so the choice comes from the environment
// (DB_CLIENT, DATABASE_URL, DB_*) or, failing that, a bootstrap file an administrator writes under Admin > Database.
function fromEnv(env, dataDir) {
  const url = env.DATABASE_URL;
  let client = normalizeClient(env.DB_CLIENT);
  if (!client && url) client = URL_CLIENT[new URL(url).protocol];
  if (!client && env.DB_FILE) client = 'sqlite';
  if (!client && (env.DB_HOST || env.DB_NAME)) throw new Error('DB_CLIENT is required when DB_HOST/DB_NAME are set (sqlite, postgres or mariadb)');
  if (!client) return null;
  if (!DB_CLIENTS.includes(client)) throw new Error(`Unsupported DB_CLIENT "${env.DB_CLIENT}" (use sqlite, postgres or mariadb)`);
  if (client === 'sqlite') return { client, file: env.DB_FILE || path.join(dataDir, 'app.db') };
  if (url) return { client, url };
  if (!env.DB_NAME) throw new Error(`DB_NAME or DATABASE_URL is required for DB_CLIENT=${client}`);
  return {
    client, host: env.DB_HOST || 'localhost', port: Number(env.DB_PORT || DEFAULT_PORT[client]), database: env.DB_NAME,
    user: env.DB_USER || '', password: env.DB_PASSWORD || '', ssl: env.DB_SSL === '1' || env.DB_SSL === 'true',
  };
}

function fromFile(dataDir) {
  const file = bootstrapFile(dataDir);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const client = normalizeClient(raw.client);
  if (!DB_CLIENTS.includes(client)) throw new Error(`${file}: unsupported client "${raw.client}"`);
  if (client === 'sqlite') return { client, file: raw.file || path.join(dataDir, 'app.db') };
  const { password_enc, ...rest } = raw;
  return { ...rest, client, password: password_enc ? decrypt(password_enc) : '' };
}

/** Who decides the engine: 'environment' (read-only in the UI) or 'admin' (db.json / default SQLite). */
export function dbManagement({ env = process.env } = {}) {
  return env.DB_CLIENT || env.DATABASE_URL || env.DB_FILE ? 'environment' : 'admin';
}

/** Effective connection settings. Defaults to SQLite at DATA_DIR/app.db. */
export function resolveDbConfig({ env = process.env, dataDir = config.dataDir } = {}) {
  return fromEnv(env, dataDir) || fromFile(dataDir) || { client: 'sqlite', file: config.dbFile };
}

/** Persist an administrator's choice (applied on the next start). The password is encrypted at rest. */
export function saveDbConfig(input, { dataDir = config.dataDir } = {}) {
  const client = normalizeClient(input.client);
  if (!DB_CLIENTS.includes(client)) throw new Error('Unsupported database engine');
  let out;
  if (client === 'sqlite') out = { client };
  else {
    if (!input.url && !input.database) throw new Error('A database name or URL is required');
    const { password, ...rest } = input;
    out = { ...rest, client, port: Number(input.port || DEFAULT_PORT[client]) };
    if (password) out.password_enc = encrypt(password);
  }
  const file = bootstrapFile(dataDir);
  fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
  return out;
}

/** Same as the resolved config but safe to send to the browser. */
export const publicDbConfig = ({ password, url, ...rest }) => ({ ...rest, hasPassword: !!password, url: url ? url.replace(/\/\/[^@/]*@/, '//***@') : undefined });
