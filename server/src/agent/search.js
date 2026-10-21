import { Worker } from 'node:worker_threads';

export const MAX_PATTERN = 1000;
const LIMITS = { maxFiles: 2000, maxDepth: 20, maxHits: 200, maxLine: 2000 };

// Regex search over a directory tree, executed in a worker thread with a hard deadline. JavaScript regexes can backtrack
// exponentially and cannot be interrupted on the main thread, which would freeze the server for every user.
// Resolves to { hits } | { timedOut: true } | { error }.
export function searchFiles({ root, dir, pattern, secretGlobs = [], skipDirs, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    let done = false;
    const w = new Worker(new URL('./search-worker.js', import.meta.url), { workerData: { root, dir, pattern, secretGlobs, skipDirs: [...skipDirs], ...LIMITS } });
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); w.terminate(); resolve(r); };
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    w.once('message', finish);
    w.once('error', (e) => finish({ error: String(e.message || e) }));
    w.once('exit', () => finish({ error: 'search_failed' }));
  });
}
