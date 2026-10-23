import crypto from 'node:crypto';
import { createKnex } from '../src/db/knex.js';

// Engines the database tests run on. Default: SQLite only. TEST_DB=sqlite,postgres,mariadb adds the others (see docker-compose.test.yml);
// override the admin connections with TEST_PG_URL / TEST_MARIADB_URL.
export const ENGINES = (process.env.TEST_DB || 'sqlite').split(',').map((e) => e.trim()).filter(Boolean);
const ADMIN_URL = {
  postgres: process.env.TEST_PG_URL || 'postgres://test:test@localhost:55432/postgres',
  mariadb: process.env.TEST_MARIADB_URL || 'mysql://root:test@localhost:53306/',
};

/** A Knex instance on an empty, private database for one test file, plus `drop()` to remove it. */
export async function makeTestKnex(engine) {
  if (engine === 'sqlite') {
    const k = createKnex({ client: 'sqlite', file: ':memory:' });
    return { knex: k, drop: () => k.destroy() };
  }
  const admin = createKnex({ client: engine, url: ADMIN_URL[engine] });
  const name = `t_${crypto.randomBytes(6).toString('hex')}`;
  await admin.raw(engine === 'postgres' ? `CREATE DATABASE ${name}` : `CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  const url = new URL(ADMIN_URL[engine]); url.pathname = `/${name}`;
  const knex = createKnex({ client: engine, url: url.toString() });
  return {
    knex,
    drop: async () => { await knex.destroy(); await admin.raw(`DROP DATABASE ${name}`); await admin.destroy(); },
  };
}
