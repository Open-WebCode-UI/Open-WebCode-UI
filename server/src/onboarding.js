import { getDb } from './db/index.js';

const dto = (row) => ({ isCompleted: !!row?.is_completed, lastStepIndex: row?.last_step_index ?? 0 });

export function getOnboarding(userId) {
  return dto(getDb().prepare('SELECT is_completed, last_step_index FROM tutorial_status WHERE user_id=?').get(userId));
}

// Progress writes are ignored once the tour is finished (a late, out-of-order request must not un-finish it);
// `restart` is the explicit way to start over (the Profile "Replay tutorial" button).
export function updateOnboarding(userId, stepIndex, { restart = false } = {}) {
  const db = getDb();
  const cur = getOnboarding(userId);
  if (cur.isCompleted && !restart) return cur;
  db.prepare(`INSERT INTO tutorial_status (user_id, is_completed, last_step_index) VALUES (?, 0, ?)
    ON CONFLICT(user_id) DO UPDATE SET is_completed=0, last_step_index=excluded.last_step_index, updated_at=strftime('%s','now')`).run(userId, stepIndex);
  return getOnboarding(userId);
}

export function completeOnboarding(userId) {
  getDb().prepare(`INSERT INTO tutorial_status (user_id, is_completed, last_step_index) VALUES (?, 1, 0)
    ON CONFLICT(user_id) DO UPDATE SET is_completed=1, updated_at=strftime('%s','now')`).run(userId);
  return getOnboarding(userId);
}
