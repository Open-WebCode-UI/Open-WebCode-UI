import { getDb } from './db/index.js';
import { sha256, redact } from './crypto.js';

// Append-only, hash-chained audit log. Any edit/removal of earlier rows breaks verifyAudit().
export function audit(actor, action, target = null, detail = {}) {
  const db = getDb();
  const ts = Math.floor(Date.now() / 1000);
  const d = JSON.stringify(redact(detail));
  const tx = db.transaction(() => {
    const prev = db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get()?.hash || 'GENESIS';
    const hash = sha256([prev, ts, actor, action, target, d].join('|'));
    db.prepare('INSERT INTO audit (ts, actor, action, target, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?)')
      .run(ts, actor == null ? null : String(actor), action, target == null ? null : String(target), d, prev, hash);
  });
  tx();
}

export function verifyAudit() {
  let prev = 'GENESIS', count = 0;
  // Stream rows so memory stays flat as the log grows.
  for (const r of getDb().prepare('SELECT * FROM audit ORDER BY id').iterate()) {
    const expect = sha256([prev, r.ts, r.actor, r.action, r.target, r.detail].join('|'));
    if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, brokenAt: r.id };
    prev = r.hash; count++;
  }
  return { ok: true, count };
}
