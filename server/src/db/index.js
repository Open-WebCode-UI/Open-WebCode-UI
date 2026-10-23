import Database from 'better-sqlite3';
import { createKnex, knexOnConnection } from './knex.js';
import { legacySchema, legacyMigrate } from './legacy-migrate.js';
import { ALL_PERMISSIONS, BUILTIN_ROLES } from '../permissions.js';

let current;

export function openDb(file = ':memory:') {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(legacySchema);
  legacyMigrate(db);
  seedRoles(db);
  return db;
}

export function seedRoles(db) {
  for (const [name, def] of Object.entries(BUILTIN_ROLES)) {
    let row = db.prepare('SELECT id FROM roles WHERE name=?').get(name);
    if (!row) {
      const r = db.prepare('INSERT INTO roles (name, description, builtin) VALUES (?,?,1)').run(name, def.description);
      row = { id: Number(r.lastInsertRowid) };
    }
    // Administrator is immutable: always resynced to the full permission list.
    if (name === 'administrator') {
      db.prepare('DELETE FROM role_permissions WHERE role_id=?').run(row.id);
      for (const p of ALL_PERMISSIONS) db.prepare('INSERT INTO role_permissions VALUES (?,?)').run(row.id, p);
    } else if (!db.prepare('SELECT 1 FROM role_permissions WHERE role_id=? LIMIT 1').get(row.id)) {
      for (const p of def.permissions) db.prepare('INSERT INTO role_permissions VALUES (?,?)').run(row.id, p);
    }
  }
}

export function initDb(file) { current = openDb(file); knex = knexOnConnection(current); return current; }
export function getDb() { if (!current) throw new Error('DB not initialized'); return current; }
export function setDb(db) { current = db; knex = knexOnConnection(db); }

// Knex handle for the multi-engine layer. Call sites move from getDb() (better-sqlite3, SQLite only) to getKnex() file by file.
let knex;
export function initKnex(dbConfig) { knex = createKnex(dbConfig); return knex; }
export function getKnex() { if (!knex) throw new Error('Knex not initialized'); return knex; }
export function setKnex(k) { knex = k; }
