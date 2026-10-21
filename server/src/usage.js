import { getDb } from './db/index.js';
import { getSettings } from './settings.js';

// Prices are USD per 1M tokens (the unit providers publish); cost is stored in USD.
export const costOf = (inputTokens, outputTokens, m) => ((inputTokens * (m?.input_price ?? 0)) + (outputTokens * (m?.output_price ?? 0))) / 1_000_000;

// Records one model request against the price in force right now. `model` is the models row (see resolveModel()).
export function recordUsage({ userId, conversationId = null, model, provider, kind = 'agent', inputTokens = 0, outputTokens = 0, estimated = false }) {
  if (!inputTokens && !outputTokens) return;
  getDb().prepare('INSERT INTO usage (user_id, conversation_id, model_row_id, provider_name, model_label, model_id, kind, input_tokens, output_tokens, estimated, cost) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(userId ?? null, conversationId, model.id, provider?.name ?? null, model.label || model.model_id, model.model_id, kind, inputTokens, outputTokens, +estimated, costOf(inputTokens, outputTokens, model));
}

// Whether this user may see their own spend: the administrator's switch shows it to everyone, and the spend.view permission to
// the roles that hold it. (Neither affects the admin usage reports, which have their own permission.)
export const canSeeSpend = (permissions) => !!getSettings('general').showSessionCost || !!permissions?.has('spend.view');

// Total spend per conversation, or null when this user is not allowed to see costs.
export function sessionCosts(ids, permissions) {
  if (!canSeeSpend(permissions) || !ids.length) return null;
  const rows = getDb().prepare(`SELECT conversation_id id, SUM(cost) cost FROM usage WHERE conversation_id IN (${ids.map(() => '?').join(',')}) GROUP BY conversation_id`).all(...ids);
  return new Map(rows.map((r) => [r.id, r.cost]));
}

// Spend grouped by model (and provider) between two unix times; also per day for a simple trend.
export function usageReport({ from = 0, to = Math.floor(Date.now() / 1000) + 1 } = {}) {
  const db = getDb();
  const byModel = db.prepare(`SELECT COALESCE(model_id, model_label) model, provider_name provider, MAX(model_label) label, COUNT(*) requests,
      SUM(input_tokens) inputTokens, SUM(output_tokens) outputTokens, SUM(estimated) estimatedRequests, SUM(cost) cost
    FROM usage WHERE ts>=? AND ts<? GROUP BY COALESCE(model_id, model_label), provider_name ORDER BY cost DESC, model`).all(from, to);
  // Rows survive a deleted user (user_id becomes NULL), so those are grouped as one "deleted user" line.
  const byUser = db.prepare(`SELECT u.id userId, COALESCE(u.display_name, u.username, u.email) name, u.username username, COUNT(*) requests,
      SUM(g.input_tokens) inputTokens, SUM(g.output_tokens) outputTokens, SUM(g.cost) cost,
      (SELECT GROUP_CONCAT(DISTINCT COALESCE(model_id, model_label)) FROM usage x WHERE x.user_id IS g.user_id AND x.ts>=? AND x.ts<?) models
    FROM usage g LEFT JOIN users u ON u.id=g.user_id WHERE g.ts>=? AND g.ts<? GROUP BY g.user_id ORDER BY cost DESC`).all(from, to, from, to);
  const byDay = db.prepare(`SELECT strftime('%Y-%m-%d', ts, 'unixepoch') day, SUM(cost) cost, SUM(input_tokens + output_tokens) tokens, COUNT(*) requests, COUNT(DISTINCT user_id) activeUsers FROM usage WHERE ts>=? AND ts<? GROUP BY day ORDER BY day`).all(from, to);
  // Each day's spend split by model, for the stacked daily chart.
  const byDayModel = db.prepare(`SELECT strftime('%Y-%m-%d', ts, 'unixepoch') day, COALESCE(model_id, model_label) model, provider_name provider, SUM(cost) cost, COUNT(*) requests FROM usage WHERE ts>=? AND ts<? GROUP BY day, COALESCE(model_id, model_label), provider_name ORDER BY day`).all(from, to);
  // What the spend went on: the agent, the chat tabs, course tutors/exercises, or context compaction.
  const byKind = db.prepare('SELECT kind, COUNT(*) requests, SUM(input_tokens) inputTokens, SUM(output_tokens) outputTokens, SUM(cost) cost FROM usage WHERE ts>=? AND ts<? GROUP BY kind ORDER BY cost DESC, kind').all(from, to);
  const byProvider = db.prepare("SELECT COALESCE(provider_name, '(unknown)') provider, COUNT(*) requests, SUM(input_tokens + output_tokens) tokens, SUM(cost) cost FROM usage WHERE ts>=? AND ts<? GROUP BY provider_name ORDER BY cost DESC, provider").all(from, to);
  // The costliest sessions and chats. Rows outlive a deleted conversation (conversation_id becomes NULL) and are left out here.
  const topSessions = db.prepare(`SELECT c.id id, COALESCE(NULLIF(c.title, ''), '(untitled)') title, c.kind kind, COALESCE(u.display_name, u.username, u.email) user, COUNT(*) requests,
      SUM(g.input_tokens + g.output_tokens) tokens, SUM(g.cost) cost
    FROM usage g JOIN conversations c ON c.id=g.conversation_id LEFT JOIN users u ON u.id=c.user_id WHERE g.ts>=? AND g.ts<? GROUP BY c.id ORDER BY cost DESC, c.id LIMIT 10`).all(from, to);
  const span = Math.max(to - from, 1);
  const total = (a, b) => db.prepare('SELECT COUNT(*) requests, COALESCE(SUM(input_tokens + output_tokens), 0) tokens, COALESCE(SUM(cost), 0) cost, COUNT(DISTINCT user_id) activeUsers, COALESCE(SUM(estimated), 0) estimatedRequests FROM usage WHERE ts>=? AND ts<?').get(a, b);
  const now = total(from, to); const prev = from > 0 ? total(Math.max(from - span, 0), from) : null; // "previous period" is the same length immediately before
  // Month to date and a straight-line projection to month end, whatever range is shown.
  const d = new Date(); const monthStart = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
  const monthEnd = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000); const nowSec = Math.floor(Date.now() / 1000);
  const mtd = total(monthStart, monthEnd).cost; const elapsed = Math.max(nowSec - monthStart, 1);
  const month = { spent: mtd, projected: mtd * ((monthEnd - monthStart) / elapsed) };
  const unpriced = db.prepare('SELECT model_id label FROM models WHERE enabled=1 AND (input_price IS NULL OR output_price IS NULL)').all().map((r) => r.label);
  const sum = (k) => byModel.reduce((a, r) => a + (r[k] || 0), 0);
  return { from, to, byModel, byUser, byDay, byDayModel, byKind, byProvider, topSessions, unpriced, month, previous: prev,
    totals: { requests: sum('requests'), inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cost: sum('cost'), activeUsers: now.activeUsers, estimatedRequests: now.estimatedRequests } };
}

// The per-request rows in a range, for download as CSV (so finance can pivot them elsewhere).
export function usageRows({ from = 0, to = Math.floor(Date.now() / 1000) + 1 } = {}) {
  return getDb().prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%SZ', g.ts, 'unixepoch') time, COALESCE(u.username, u.email, '(deleted user)') user, g.kind, g.provider_name provider, COALESCE(g.model_id, g.model_label) model,
      g.input_tokens inputTokens, g.output_tokens outputTokens, g.estimated estimated, g.cost cost FROM usage g LEFT JOIN users u ON u.id=g.user_id WHERE g.ts>=? AND g.ts<? ORDER BY g.ts, g.id`).all(from, to);
}
