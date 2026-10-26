import { getKnex } from '../src/db/index.js';

// Raw SQL for tests, with the same shape as the handle the tests used before (prepare().get/all/run, exec). Every call is async.
export function sqlDb() {
  const k = getKnex();
  return {
    prepare(text) {
      const run = (args) => k.raw(text, args);
      return {
        get: async (...args) => { const r = await run(args); return Array.isArray(r) ? r[0] : r; },
        all: async (...args) => { const r = await run(args); return Array.isArray(r) ? r : []; },
        run: async (...args) => { const r = await run(args); return { changes: r.changes ?? 0, lastInsertRowid: Number(r.lastInsertRowid ?? 0) }; },
      };
    },
    exec: (text) => k.raw(text),
  };
}

// Runs a script of several statements (separated by ';') on a Knex handle, one statement at a time.
export async function execAll(knex, script) {
  for (const stmt of script.split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean)) await knex.raw(stmt);
}
