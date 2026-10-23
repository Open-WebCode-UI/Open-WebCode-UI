import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDbConfig, saveDbConfig, dbManagement, publicDbConfig } from '../src/db/connection.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dbconn-'));

describe('db connection selection', () => {
  it('defaults to SQLite', () => {
    const dataDir = tmp();
    expect(resolveDbConfig({ env: {}, dataDir }).client).toBe('sqlite');
    expect(dbManagement({ env: {} })).toBe('admin');
  });

  it('reads Postgres and MariaDB from the environment', () => {
    const dataDir = tmp();
    expect(resolveDbConfig({ env: { DATABASE_URL: 'postgres://u:p@h/db' }, dataDir })).toMatchObject({ client: 'postgres', url: 'postgres://u:p@h/db' });
    expect(resolveDbConfig({ env: { DB_CLIENT: 'mariadb', DB_NAME: 'app', DB_USER: 'u' }, dataDir })).toMatchObject({ client: 'mariadb', host: 'localhost', port: 3306, database: 'app' });
    expect(dbManagement({ env: { DB_CLIENT: 'postgres' } })).toBe('environment');
  });

  it('rejects an unknown engine', () => {
    expect(() => resolveDbConfig({ env: { DB_CLIENT: 'oracle' }, dataDir: tmp() })).toThrow(/Unsupported/);
  });

  it('round-trips the admin choice with an encrypted password', () => {
    const dataDir = tmp();
    saveDbConfig({ client: 'postgres', host: 'db', database: 'app', user: 'u', password: 's3cret' }, { dataDir });
    expect(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8')).not.toContain('s3cret');
    const cfg = resolveDbConfig({ env: {}, dataDir });
    expect(cfg).toMatchObject({ client: 'postgres', host: 'db', port: 5432, password: 's3cret' });
    expect(publicDbConfig(cfg).password).toBeUndefined();
    expect(publicDbConfig(cfg).hasPassword).toBe(true);
  });

  it('environment wins over the bootstrap file', () => {
    const dataDir = tmp();
    saveDbConfig({ client: 'postgres', database: 'app' }, { dataDir });
    expect(resolveDbConfig({ env: { DB_CLIENT: 'sqlite' }, dataDir }).client).toBe('sqlite');
  });
});
