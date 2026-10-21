import { useSyncExternalStore } from 'react';
import { post } from './api.js';

// Pending shell-command approvals from the agent. Shared by the chat panel and the terminal pane, so the user can allow or deny
// from either place and the other one updates at once.
let queue = [];
const subs = new Set();
const notify = () => subs.forEach((f) => f());

export const approvals = {
  push(a) { if (!queue.some((x) => x.id === a.id)) { queue = [...queue, a]; notify(); } },
  clear() { if (queue.length) { queue = []; notify(); } },
  async answer(id, value, message) { queue = queue.filter((x) => x.id !== id); notify(); await post('/api/agent/respond', { id, value, ...(message?.trim() ? { message: message.trim() } : {}) }).catch(() => {}); },
  subscribe(f) { subs.add(f); return () => subs.delete(f); },
  snapshot() { return queue; },
};
export const useApprovals = () => useSyncExternalStore(approvals.subscribe, approvals.snapshot);
