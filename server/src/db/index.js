import { createKnex } from './knex.js';
import { migrateToLatest } from './migrator.js';
import { loadSettings } from '../settings.js';
import { ALL_PERMISSIONS, BUILTIN_ROLES } from '../permissions.js';
import { resolveDbConfig } from './connection.js';

let current = null;

/** Opens a database (a Knex handle), brings its schema up to date, seeds the built-in roles and loads the settings cache. */
export async function openDb(file = ':memory:') {
  return prepareDb(createKnex({ client: 'sqlite', file }));
}

/** Brings a fresh or existing database (any engine) to the current schema, seeds the built-in roles and loads the settings cache. */
export async function prepareDb(knex) {
  try {
    await migrateToLatest(knex);
    await seedRoles(knex);
    await loadSettings(knex);
  } catch (e) { await knex.destroy(); throw e; }
  return knex;
}

/** Opens the configured database for the server process (see db/connection.js for how the engine is chosen). */
export async function initDb(dbConfig = resolveDbConfig()) {
  current = await prepareDb(createKnex(dbConfig));
  return current;
}

export async function seedRoles(knex) {
  for (const [name, def] of Object.entries(BUILTIN_ROLES)) {
    let row = await knex('roles').where({ name }).first('id');
    if (!row) {
      const [inserted] = await knex('roles').insert({ name, description: def.description, builtin: 1 }).returning('id');
      row = { id: Number(inserted?.id ?? inserted) };
    }
    // Administrator is immutable: always resynced to the full permission list.
    if (name === 'administrator') {
      await knex('role_permissions').where({ role_id: row.id }).del();
      await knex('role_permissions').insert(ALL_PERMISSIONS.map((permission) => ({ role_id: row.id, permission })));
    } else if (!(await knex('role_permissions').where({ role_id: row.id }).first('permission'))) {
      if (def.permissions.length) await knex('role_permissions').insert(def.permissions.map((permission) => ({ role_id: row.id, permission })));
    }
  }
}

export function getKnex() {
  if (!current) throw new Error('DB not initialized');
  return current;
}
/** Points the process at another handle (tests use one per file). The settings cache follows it. */
export async function setDb(knex) { current = knex; await loadSettings(knex); }
