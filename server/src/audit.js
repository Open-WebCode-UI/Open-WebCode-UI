import { getKnex } from './db/index.js';
import { engineOf } from './db/knex.js';
import { sha256, redact } from './crypto.js';

// Append-only, hash-chained audit log. Any edit/removal of earlier rows breaks verifyAudit().
// Writes are queued in this process, so the chain cannot fork between two requests here. On PostgreSQL and MariaDB the last row is also
// locked while a row is added, which covers writers on other instances (SQLite is single-writer already).
let queue = Promise.resolve();

export function audit(actor, action, target = null, detail = {}) {
  const k = getKnex();
  const ts = Math.floor(Date.now() / 1000);
  const d = JSON.stringify(redact(detail));
  const write = async () => {
    await k.transaction(async (t) => {
      let last = t('audit').select('hash').orderBy('id', 'desc').limit(1);
      if (engineOf(k) !== 'sqlite') last = last.forUpdate();
      const prev = (await last.first())?.hash || 'GENESIS';
      const hash = sha256([prev, ts, actor, action, target, d].join('|'));
      await t('audit').insert({
        ts, actor: actor == null ? null : String(actor), action, target: target == null ? null : String(target), detail: d, prev_hash: prev, hash,
      });
    });
  };
  const done = queue.then(write);
  queue = done.catch(() => {}); // a failed write must not block the ones after it
  return done;
}

export async function verifyAudit() {
  let prev = 'GENESIS', count = 0;
  // Read in pages so memory stays flat as the log grows.
  const k = getKnex();
  let after = 0;
  for (;;) {
    const rows = await k('audit').where('id', '>', after).orderBy('id').limit(500);
    if (!rows.length) break;
    for (const r of rows) {
      const expect = sha256([prev, r.ts, r.actor, r.action, r.target, r.detail].join('|'));
      if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, brokenAt: r.id };
      prev = r.hash; count++;
    }
    after = rows[rows.length - 1].id;
  }
  return { ok: true, count };
}
