import knexFactory from 'knex';
import pg from 'pg';

// pg returns BIGINT (COUNT, SUM of integers) and NUMERIC as strings; the app expects JS numbers like better-sqlite3 gives.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

function sqliteConfig(c) {
  return {
    client: 'better-sqlite3',
    connection: { filename: c.file },
    useNullAsDefault: true,
    // An in-memory database exists per connection, so it must be a single one.
    pool: {
      ...(c.file === ':memory:' ? { min: 1, max: 1 } : {}),
      afterCreate(conn, done) { conn.pragma('foreign_keys = ON'); if (c.file !== ':memory:') conn.pragma('journal_mode = WAL'); done(null, conn); },
    },
  };
}

function networkConfig(c) {
  const pool = { min: 0, max: Number(c.poolMax || 10) };
  if (c.client === 'postgres') {
    const connection = c.url
      ? { connectionString: c.url }
      : { host: c.host, port: c.port, database: c.database, user: c.user, password: c.password, ...(c.ssl && { ssl: { rejectUnauthorized: false } }) };
    return { client: 'pg', connection, pool };
  }
  const base = { supportBigNumbers: true, bigNumberStrings: false, decimalNumbers: true };
  const u = c.url && new URL(c.url);
  const connection = u
    ? { host: u.hostname, port: Number(u.port || 3306), database: decodeURIComponent(u.pathname.slice(1)), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), ...base }
    : { host: c.host, port: c.port, database: c.database, user: c.user, password: c.password, ...(c.ssl && { ssl: {} }), ...base };
  return {
    client: 'mysql2', connection,
    // MariaDB reads || as OR by default; make it string concatenation (as in SQLite/Postgres) and keep strict inserts.
    pool: { ...pool, afterCreate(conn, done) { conn.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION,PIPES_AS_CONCAT'", (e) => done(e, conn)); } },
  };
}

/** Builds a Knex instance from a config returned by resolveDbConfig(). */
export function createKnex(c) {
  return knexFactory(c.client === 'sqlite' ? sqliteConfig(c) : networkConfig(c));
}

export const engineOf = (knex) => ({ 'better-sqlite3': 'sqlite', pg: 'postgres', mysql2: 'mariadb' })[knex.client.config.client];
