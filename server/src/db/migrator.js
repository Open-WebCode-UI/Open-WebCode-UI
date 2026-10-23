import Database from 'better-sqlite3';
import { engineOf } from './knex.js';
import { legacySchema, legacyMigrate } from './legacy-migrate.js';
import * as baseline from './migrations/001_baseline.js';

const MIGRATIONS = { '001_baseline': baseline }; // add new schema changes here, in order

const migrationSource = {
  getMigrations: async () => Object.keys(MIGRATIONS),
  getMigrationName: (name) => name,
  getMigration: (name) => MIGRATIONS[name],
};
const options = { migrationSource };

/**
 * Brings the database to the latest schema. A SQLite file created before Knex (it has tables but no knex_migrations) is first upgraded
 * with the old in-place migrations, then adopted by the baseline, so existing installs keep their data.
 */
export async function migrateToLatest(knex) {
  if (engineOf(knex) === 'sqlite') await upgradeLegacySqlite(knex);
  const [, applied] = await knex.migrate.latest(options);
  return applied;
}

export const migrationStatus = async (knex) => {
  const [done, pending] = await knex.migrate.list(options);
  return { applied: done.map((m) => m.name ?? m), pending: pending.map((m) => m.name ?? m) };
};

async function upgradeLegacySqlite(knex) {
  const file = knex.client.config.connection.filename;
  if (!file || file === ':memory:') return;
  if (!(await knex.schema.hasTable('users')) || (await knex.schema.hasTable('knex_migrations'))) return;
  const db = new Database(file);
  try {
    db.pragma('foreign_keys = ON');
    db.exec(legacySchema);
    legacyMigrate(db);
  } finally { db.close(); }
}
