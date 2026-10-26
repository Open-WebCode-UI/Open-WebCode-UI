import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createKnex } from '../src/db/knex.js';
import { migrateToLatest, migrationStatus } from '../src/db/migrator.js';
import { legacySchema, legacyMigrate } from '../src/db/legacy-migrate.js';

const open = [];
const mem = () => { const k = createKnex({ client: 'sqlite', file: ':memory:' }); open.push(k); return k; };
afterEach(async () => { while (open.length) await open.pop().destroy(); });

// table -> column -> { notnull, pk } as SQLite reports it (primary keys count as NOT NULL: Knex says so, old DDL left it implicit).
function shape(db) {
  const out = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'knex_%'").all()) {
    out[name] = Object.fromEntries(db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => [c.name, { notnull: c.pk ? 1 : c.notnull, pk: c.pk }]));
  }
  return out;
}

describe('baseline migration', () => {
  it('creates the same tables and columns as the legacy schema', async () => {
    const legacy = new Database(':memory:'); // schema.sql + every migrate() step, as the pre-Knex code built it
    legacy.exec(legacySchema); legacyMigrate(legacy);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'base-')), 'fresh.db');
    const k = createKnex({ client: 'sqlite', file }); open.push(k);
    await migrateToLatest(k);
    await k.destroy(); open.pop();
    const fresh = new Database(file);
    const a = shape(legacy), b = shape(fresh);
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    for (const t of Object.keys(a)) {
      expect({ t, cols: Object.keys(b[t]).sort() }).toEqual({ t, cols: Object.keys(a[t]).sort() });
      for (const c of Object.keys(a[t])) expect({ t, c, ...b[t][c] }).toEqual({ t, c, ...a[t][c] });
    }
    fresh.close();
  });

  it('enforces the partial unique indexes and foreign keys', async () => {
    const k = mem();
    await migrateToLatest(k);
    await k('users').insert({ source: 'local', username: 'ann' });
    await expect(k('users').insert({ source: 'local', username: 'ann' })).rejects.toThrow(/UNIQUE/i);
    await k('users').insert({ source: 'saml', username: 'ann', idp_entity_id: 'idp', name_id: 'n1' }); // same name, other source: allowed
    await expect(k('users').insert({ source: 'saml', idp_entity_id: 'idp', name_id: 'n1' })).rejects.toThrow(/UNIQUE/i);
    await expect(k('role_permissions').insert({ role_id: 999, permission: 'x' })).rejects.toThrow(/FOREIGN KEY/i);
    const { id } = await k('users').where({ username: 'ann', source: 'local' }).first();
    expect((await k('users').where({ id }).first()).created_at).toBeGreaterThan(1.7e9);
  });

  it('is idempotent and reports status', async () => {
    const k = mem();
    expect(await migrateToLatest(k)).toEqual(['001_baseline']);
    expect(await migrateToLatest(k)).toEqual([]);
    expect(await migrationStatus(k)).toEqual({ applied: ['001_baseline'], pending: [] });
  });

  it('adopts a pre-Knex SQLite database and keeps its data', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-')), 'old.db');
    // An old database: the original providers table (CHECK without newer types) and no knex_migrations.
    const old = new Database(file);
    old.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL CHECK (source IN ('saml','local')), username TEXT, email TEXT, first_name TEXT, last_name TEXT, display_name TEXT, idp_entity_id TEXT, name_id TEXT, password_hash TEXT, is_break_glass INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, must_change_password INTEGER NOT NULL DEFAULT 0, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, lockouts INTEGER NOT NULL DEFAULT 0, totp_secret_enc TEXT, mfa_enrolled INTEGER NOT NULL DEFAULT 0, totp_confirmed INTEGER NOT NULL DEFAULT 0, totp_last_step INTEGER NOT NULL DEFAULT 0, last_login INTEGER, created_at INTEGER NOT NULL DEFAULT 0)");
    old.exec("INSERT INTO users (source, username, created_at) VALUES ('local','legacy-user', 5)");
    old.close();

    const k = createKnex({ client: 'sqlite', file }); open.push(k);
    expect(await migrateToLatest(k)).toEqual(['001_baseline']);
    expect(await k('users').where({ username: 'legacy-user' }).first()).toMatchObject({ created_at: 5, memory_enabled: 0, web_search_enabled: 1 });
    expect(await k.schema.hasTable('providers')).toBe(true);
    expect(await k.schema.hasColumn('models', 'featured_badge_id')).toBe(true);
    expect(await migrateToLatest(k)).toEqual([]);
  });
});
