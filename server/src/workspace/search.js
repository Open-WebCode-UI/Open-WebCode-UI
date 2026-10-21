import { Worker } from 'node:worker_threads';

export const MAX_QUERY = 500;
const LIMITS = { maxFiles: 5000, maxDepth: 20, maxMatches: 1000, maxLine: 2000 };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Find-in-files over a project directory, executed in a worker thread with a hard deadline (a JavaScript regex can backtrack
// exponentially and cannot be interrupted on the main thread). Resolves to { results, matches, truncated } | { timedOut } | { error }.
export function searchProject({ root, dir, query, regex = false, caseSensitive = false, wholeWord = false, include = [], exclude = [], skipDirs, timeoutMs = 8000 }) {
  let source = regex ? query : esc(query);
  if (wholeWord) source = `\\b(?:${source})\\b`;
  return new Promise((resolve) => {
    let done = false;
    const w = new Worker(new URL('./search-worker.js', import.meta.url), { workerData: { root, dir, source, flags: caseSensitive ? '' : 'i', include, exclude, skipDirs: [...skipDirs], ...LIMITS } });
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); w.terminate(); resolve(r); };
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    w.once('message', finish);
    w.once('error', (e) => finish({ error: String(e.message || e) }));
    w.once('exit', () => finish({ error: 'search_failed' }));
  });
}
