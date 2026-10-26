import crypto from 'node:crypto';
import { createKnex } from '../src/db/knex.js';

// The database engine the test suite runs on: TEST_ENGINE=sqlite (default), postgres or mariadb. The servers come from
// docker-compose.test.yml (or any reachable servers, see TEST_PG_URL / TEST_MARIADB_URL).
// TEST_DB lists the engines the engine-level checks (db-engines.test.js) run on.
export const SUITE_ENGINE = process.env.TEST_ENGINE || 'sqlite';
export const ENGINES = (process.env.TEST_DB || 'sqlite').split(',').map((e) => e.trim()).filter(Boolean);
const ADMIN_URL = {
  postgres: process.env.TEST_PG_URL || 'postgres://test:test@localhost:55432/postgres',
  mariadb: process.env.TEST_MARIADB_URL || 'mysql://root:test@localhost:53306/',
};
// Test files run in parallel, each with its own database; small pools keep the servers' connection limits in reach.
const POOL_MAX = 4;

async function withAdmin(engine, fn) {
  const admin = createKnex({ client: engine, url: ADMIN_URL[engine], poolMax: 1 });
  try { return await fn(admin); } finally { await admin.destroy(); }
}

/** A Knex instance on an empty, private database, plus `drop()` to remove it. */
export async function makeTestKnex(engine) {
  if (engine === 'sqlite') {
    const k = createKnex({ client: 'sqlite', file: ':memory:' });
    return { knex: k, drop: () => k.destroy() };
  }
  const name = `t_${crypto.randomBytes(6).toString('hex')}`;
  await withAdmin(engine, (admin) => admin.raw(engine === 'postgres' ? `CREATE DATABASE ${name}` : `CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`));
  const url = new URL(ADMIN_URL[engine]); url.pathname = `/${name}`;
  const knex = createKnex({ client: engine, url: url.toString(), poolMax: POOL_MAX });
  return {
    knex,
    drop: async () => {
      await knex.destroy();
      await withAdmin(engine, (admin) => admin.raw(`DROP DATABASE ${name}`));
    },
  };
}

/** Empties every application table (the migration bookkeeping stays), with ids starting again from 1, as a new database would. */
export async function resetDatabase(knex, engine) {
  const tables = engine === 'postgres'
    ? (await knex.raw("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'knex_%'")).rows.map((r) => r.t)
    : (await knex.raw("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name NOT LIKE 'knex_%'"))[0].map((r) => r.t);
  if (!tables.length) return;
  if (engine === 'postgres') {
    await knex.raw(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
    return;
  }
  // MariaDB: truncate table by table with the foreign-key checks off, on one connection.
  await knex.transaction(async (trx) => {
    await trx.raw('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of tables) await trx.raw('TRUNCATE TABLE ??', [t]);
    await trx.raw('SET FOREIGN_KEY_CHECKS = 1');
  });
}
