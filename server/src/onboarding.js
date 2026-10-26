import { getKnex } from './db/index.js';

const dto = (row) => ({ isCompleted: !!row?.is_completed, lastStepIndex: row?.last_step_index ?? 0 });
const now = () => Math.floor(Date.now() / 1000);

export async function getOnboarding(userId) {
  return dto(await getKnex()('tutorial_status').where({ user_id: userId }).first('is_completed', 'last_step_index'));
}

// Progress writes are ignored once the tour is finished (a late, out-of-order request must not un-finish it);
// `restart` is the explicit way to start over (the Profile "Replay tutorial" button).
export async function updateOnboarding(userId, stepIndex, { restart = false } = {}) {
  const cur = await getOnboarding(userId);
  if (cur.isCompleted && !restart) return cur;
  await getKnex()('tutorial_status').insert({ user_id: userId, is_completed: 0, last_step_index: stepIndex }).onConflict('user_id').merge({ is_completed: 0, last_step_index: stepIndex, updated_at: now() });
  return getOnboarding(userId);
}

export async function completeOnboarding(userId) {
  await getKnex()('tutorial_status').insert({ user_id: userId, is_completed: 1, last_step_index: 0 }).onConflict('user_id').merge({ is_completed: 1, updated_at: now() });
  return getOnboarding(userId);
}
