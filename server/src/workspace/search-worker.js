// Runs in a worker thread (see search.js): the pattern is user-supplied, so a catastrophic regex must only ever be able to burn
// this thread, which the parent terminates on a timeout.
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { relFrom, globToRegex } from './jail.js';

const { root, dir, source, flags, include, exclude, skipDirs, maxFiles, maxDepth, maxMatches, maxLine } = workerData;
const inc = include.map(globToRegex), exc = exclude.map(globToRegex);

function walk(d, out, depth = 0) {
  if (depth > maxDepth) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= maxFiles) return;
    if (e.isSymbolicLink() || skipDirs.includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1); else out.push(p);
  }
}

try {
  const re = new RegExp(source, `${flags}g`);
  const files = []; walk(dir, files);
  const results = []; let matches = 0, truncated = files.length >= maxFiles;
  for (const f of files) {
    const rel = relFrom(root, f);
    if ((inc.length && !inc.some((r) => r.test(rel))) || exc.some((r) => r.test(rel))) continue;
    let txt; try { if (fs.statSync(f).size > 1_000_000) continue; txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (txt.includes('\0')) continue;
    const hits = [];
    const lines = txt.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches < maxMatches; i++) {
      const l = lines[i].length > maxLine ? lines[i].slice(0, maxLine) : lines[i];
      re.lastIndex = 0;
      for (let m = re.exec(l); m && matches < maxMatches; m = re.exec(l)) {
        if (m[0] === '') { re.lastIndex++; continue; } // an empty match (e.g. /a*/) is not a hit
        hits.push({ line: i + 1, col: m.index + 1, length: m[0].length, text: l.slice(0, 300) });
        matches++;
      }
    }
    if (hits.length) results.push({ path: rel, hits });
    if (matches >= maxMatches) { truncated = true; break; }
  }
  parentPort.postMessage({ results, matches, truncated });
} catch (e) {
  parentPort.postMessage({ error: e instanceof SyntaxError ? 'invalid_pattern' : String(e.code || e.message || e) });
}
