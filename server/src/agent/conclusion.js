// The `conclude` tool's payload is model-written, so it is trimmed and capped before it reaches the user (and storage).
const STATUSES = ['complete', 'partial', 'blocked'];
const text = (v, n) => String(v ?? '').trim().slice(0, n);
const list = (v, max, n) => (Array.isArray(v) ? v.map((x) => text(x, n)).filter(Boolean).slice(0, max) : []);

export function normalizeConclusion(a = {}) {
  const status = STATUSES.includes(a.status) ? a.status : 'complete';
  return {
    summary: text(a.summary, 6000), status, changes: list(a.changes, 60, 300), verification: text(a.verification, 1500),
    next_steps: list(a.next_steps, 4, 200),
    needs: status === 'complete' ? '' : text(a.needs, 1000), // only meaningful when work is unfinished
  };
}
