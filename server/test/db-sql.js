import { getKnex } from '../src/db/index.js';
import { engineOf } from '../src/db/knex.js';

// Raw SQL for tests, with the shape the tests read: prepare(sql).get/all/run and exec. Every call is async. Each engine returns raw
// results differently; they are normalised here so the same test runs on SQLite, PostgreSQL and MariaDB.
export function sqlDb() {
  const k = getKnex();
  const engine = engineOf(k);
  const sqlFor = (text) => (engine === 'mariadb' ? quoteMariaDb(text) : text);
  // MariaDB reserves 'usage' and 'key' (its table and column names), so bare uses outside string literals are quoted for it.
const quoteMariaDb = (sql) => sql.split(/('(?:[^']|'')*')/).map((part, i) => (i % 2 ? part : part.replace(/\b(usage|key)\b/g, '`$1`'))).join('');

// MariaDB returns [rows, fields] for selects and [OkPacket, fields] for writes; PostgreSQL returns { rows, rowCount }.
  const mysqlPair = (r) => (engine === 'mariadb' && Array.isArray(r) && r.length === 2 && !Array.isArray(r[0]) ? r[0] : r);
  const rowsOf = (r) => {
    if (engine === 'mariadb' && Array.isArray(r) && Array.isArray(r[0])) return r[0];
    return Array.isArray(r) ? r : Array.isArray(r?.rows) ? r.rows : [];
  };
  return {
    prepare(text) {
      const isInsert = /^\s*INSERT\b/i.test(text) && !/\bRETURNING\b/i.test(text);
      return {
        get: async (...args) => rowsOf(await k.raw(sqlFor(text), args))[0],
        all: async (...args) => rowsOf(await k.raw(sqlFor(text), args)),
        run: async (...args) => {
          if (engine === 'postgres') {
            // PostgreSQL reports no insert id unless asked: RETURNING * works for any table.
            const r = await k.raw(isInsert ? `${text} RETURNING *` : text, args);
            return { changes: r.rowCount ?? 0, lastInsertRowid: Number(r.rows?.[0]?.id ?? 0) };
          }
          const r = mysqlPair(await k.raw(sqlFor(text), args));
          if (engine === 'mariadb') return { changes: r.affectedRows ?? 0, lastInsertRowid: Number(r.insertId ?? 0) };
          return { changes: r.changes ?? 0, lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
        },
      };
    },
    exec: (text) => k.raw(sqlFor(text)),
  };
}

// Runs a script of several statements (separated by ';') on a Knex handle, one statement at a time.
export async function execAll(knex, script) {
  for (const stmt of script.split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean)) await knex.raw(stmt);
}
