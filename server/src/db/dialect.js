import { engineOf } from './knex.js';

// Helpers for the few places where SQL differs between SQLite, PostgreSQL and MariaDB. Everything else goes through Knex.

/** Runs fn(trx) in a transaction; commits when it resolves, rolls back when it throws. */
export const trx = (knex, fn) => knex.transaction(fn);

/** Inserts one row and returns its auto-increment id (Knex yields it differently per engine). */
export async function insertId(q, row, idColumn = 'id') {
  const res = await q.insert(row).returning(idColumn);
  const first = Array.isArray(res) ? res[0] : res;
  return Number(first && typeof first === 'object' ? first[idColumn] : first);
}

/** Number of rows an update/delete touched (Knex already returns this as a number for all three engines). */
export const affected = (n) => Number(n) || 0;

/** Seconds since the Unix epoch, as the SQL expression for a column default or UPDATE. The app normally passes JS now(). */
export function nowEpoch(knex) {
  switch (engineOf(knex)) {
    case 'postgres': return knex.raw('CAST(EXTRACT(EPOCH FROM NOW()) AS BIGINT)');
    case 'mariadb': return knex.raw('UNIX_TIMESTAMP()');
    default: return knex.raw("CAST(strftime('%s','now') AS INTEGER)");
  }
}

/** nowEpoch() as a column DEFAULT (parenthesised, which SQLite and MariaDB require for expressions). */
export const nowDefault = (knex) => knex.raw(`(${nowEpoch(knex).toQuery()})`);

/** 'YYYY-MM-DD' (UTC) of an epoch-seconds column. */
export function dayOf(knex, col) {
  switch (engineOf(knex)) {
    case 'postgres': return knex.raw("to_char(to_timestamp(??) AT TIME ZONE 'UTC', 'YYYY-MM-DD')", [col]);
    case 'mariadb': return knex.raw("DATE_FORMAT(DATE_ADD('1970-01-01 00:00:00', INTERVAL ?? SECOND), '%Y-%m-%d')", [col]);
    default: return knex.raw("strftime('%Y-%m-%d', ??, 'unixepoch')", [col]);
  }
}

/** ISO-8601 UTC timestamp ('YYYY-MM-DDTHH:MM:SSZ') of an epoch-seconds column. */
export function isoOf(knex, col) {
  switch (engineOf(knex)) {
    case 'postgres': return knex.raw("to_char(to_timestamp(??) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')", [col]);
    case 'mariadb': return knex.raw("DATE_FORMAT(DATE_ADD('1970-01-01 00:00:00', INTERVAL ?? SECOND), '%Y-%m-%dT%H:%i:%sZ')", [col]);
    default: return knex.raw("strftime('%Y-%m-%dT%H:%M:%SZ', ??, 'unixepoch')", [col]);
  }
}

/** Comma-joined distinct values of a column (GROUP_CONCAT / string_agg). */
export function groupConcat(knex, col, sep = ',') {
  switch (engineOf(knex)) {
    case 'postgres': return knex.raw('string_agg(DISTINCT ??::text, ?)', [col, sep]);
    case 'mariadb': return knex.raw(`GROUP_CONCAT(DISTINCT ?? SEPARATOR '${sep.replace(/'/g, "''")}')`, [col]);
    default: return knex.raw('GROUP_CONCAT(DISTINCT ??)', [col]); // SQLite allows no separator with DISTINCT: always a comma
  }
}

/** Null-safe equality: `a IS NOT DISTINCT FROM b`. Returns a raw predicate for use in where/whereRaw. */
export function nullSafeEq(knex, col, value) {
  switch (engineOf(knex)) {
    case 'postgres': return knex.raw('?? IS NOT DISTINCT FROM ?', [col, value]);
    case 'mariadb': return knex.raw('?? <=> ?', [col, value]);
    default: return knex.raw('?? IS ?', [col, value]);
  }
}
