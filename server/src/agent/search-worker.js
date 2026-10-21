// Runs in a worker thread (see search.js): the pattern is model-supplied, so a catastrophic regex must only ever be able to
// burn this thread, which the parent terminates on a timeout.
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { relFrom, isSecretPath } from '../workspace/jail.js';

const { root, dir, pattern, secretGlobs, skipDirs, maxFiles, maxDepth, maxHits, maxLine } = workerData;

function walk(d, out, depth = 0) {
  if (depth > maxDepth) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (out.length >= maxFiles) return;
    if (e.isSymbolicLink() || skipDirs.includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1); else out.push(p);
  }
}

try {
  const re = new RegExp(pattern);
  const files = []; walk(dir, files);
  const hits = [];
  for (const f of files) {
    const rel = relFrom(root, f);
    if (isSecretPath(rel, secretGlobs)) continue;
    let txt; try { if (fs.statSync(f).size > 1_000_000) continue; txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (txt.includes('\0')) continue;
    txt.split('\n').forEach((l, i) => { if (hits.length < maxHits && re.test(l.slice(0, maxLine))) hits.push(`${rel}:${i + 1}: ${l.slice(0, 300)}`); });
    if (hits.length >= maxHits) break;
  }
  parentPort.postMessage({ hits });
} catch (e) {
  parentPort.postMessage({ error: String(e.code || e.message || e) });
}
