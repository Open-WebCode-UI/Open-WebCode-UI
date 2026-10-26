import { getKnex } from './db/index.js';
import { dayOf, isoOf } from './db/dialect.js';
import { getSettings } from './settings.js';

// Prices are USD per 1M tokens (the unit providers publish); cost is stored in USD.
export const costOf = (inputTokens, outputTokens, m) => ((inputTokens * (m?.input_price ?? 0)) + (outputTokens * (m?.output_price ?? 0))) / 1_000_000;

// Records one model request against the price in force right now. `model` is the models row (see resolveModel()).
export async function recordUsage({ userId, conversationId = null, model, provider, kind = 'agent', inputTokens = 0, outputTokens = 0, estimated = false }) {
  if (!inputTokens && !outputTokens) return;
  await getKnex()('usage').insert({
    user_id: userId ?? null, conversation_id: conversationId, model_row_id: model.id, provider_name: provider?.name ?? null, model_label: model.label || model.model_id,
    model_id: model.model_id, kind, input_tokens: inputTokens, output_tokens: outputTokens, estimated: +estimated, cost: costOf(inputTokens, outputTokens, model),
  });
}

// Whether this user may see their own spend: the administrator's switch shows it to everyone, and the spend.view permission to
// the roles that hold it. (Neither affects the admin usage reports, which have their own permission.)
export const canSeeSpend = (permissions) => !!getSettings('general').showSessionCost || !!permissions?.has('spend.view');

// Total spend per conversation, or null when this user is not allowed to see costs.
export async function sessionCosts(ids, permissions) {
  if (!canSeeSpend(permissions) || !ids.length) return null;
  const rows = await getKnex()('usage').whereIn('conversation_id', ids).groupBy('conversation_id').select('conversation_id as id').sum({ cost: 'cost' });
  return new Map(rows.map((r) => [r.id, r.cost]));
}

const byCostThen = (key) => (a, b) => b.cost - a.cost || String(a[key] ?? '').localeCompare(String(b[key] ?? ''));

// Spend grouped by model (and provider) between two unix times; also per day for a simple trend.
export async function usageReport({ from = 0, to = Math.floor(Date.now() / 1000) + 1 } = {}) {
  const k = getKnex();
  const inRange = (q, col = 'ts') => q.where(col, '>=', from).where(col, '<', to);
  const modelKey = k.raw('COALESCE(model_id, model_label)');

  const byModel = (await inRange(k('usage')).groupBy(modelKey, 'provider_name')
    .select({ model: modelKey, provider: 'provider_name', label: k.raw('MAX(model_label)'), requests: k.raw('COUNT(*)'), inputTokens: k.raw('SUM(input_tokens)'), outputTokens: k.raw('SUM(output_tokens)'),
      estimatedRequests: k.raw('SUM(estimated)'), cost: k.raw('SUM(cost)') })).sort(byCostThen('model'));

  // Rows survive a deleted user (user_id becomes NULL), so those are grouped as one "deleted user" line.
  const modelsOfUser = new Map();
  for (const r of await inRange(k('usage')).distinct({ userId: 'user_id', model: modelKey })) modelsOfUser.set(r.userId, [...(modelsOfUser.get(r.userId) ?? []), r.model]);
  const byUser = (await inRange(k('usage as g').leftJoin('users as u', 'u.id', 'g.user_id'), 'g.ts').groupBy('g.user_id', 'u.id', 'u.display_name', 'u.username', 'u.email')
    .select({ userId: 'u.id', name: k.raw('COALESCE(u.display_name, u.username, u.email)'), username: 'u.username', requests: k.raw('COUNT(*)'),
      inputTokens: k.raw('SUM(g.input_tokens)'), outputTokens: k.raw('SUM(g.output_tokens)'), cost: k.raw('SUM(g.cost)'), uid: 'g.user_id' }))
    .map(({ uid, ...r }) => ({ ...r, models: [...new Set(modelsOfUser.get(uid) ?? [])].sort().join(',') })).sort((a, b) => b.cost - a.cost);

  const day = dayOf(k, 'ts');
  const byDay = (await inRange(k('usage')).groupBy(day)
    .select({ day, cost: k.raw('SUM(cost)'), tokens: k.raw('SUM(input_tokens + output_tokens)'), requests: k.raw('COUNT(*)'), activeUsers: k.raw('COUNT(DISTINCT user_id)') }))
    .sort((a, b) => a.day.localeCompare(b.day));
  // Each day's spend split by model, for the stacked daily chart.
  const byDayModel = (await inRange(k('usage')).groupBy(day, modelKey, 'provider_name')
    .select({ day, model: modelKey, provider: 'provider_name', cost: k.raw('SUM(cost)'), requests: k.raw('COUNT(*)') }))
    .sort((a, b) => a.day.localeCompare(b.day) || b.cost - a.cost);
  // What the spend went on: the agent, the chat tabs, course tutors/exercises, or context compaction.
  const byKind = (await inRange(k('usage')).groupBy('kind')
    .select({ kind: 'kind', requests: k.raw('COUNT(*)'), inputTokens: k.raw('SUM(input_tokens)'), outputTokens: k.raw('SUM(output_tokens)'), cost: k.raw('SUM(cost)') })).sort(byCostThen('kind'));
  const providerKey = k.raw("COALESCE(provider_name, '(unknown)')");
  const byProvider = (await inRange(k('usage')).groupBy(providerKey)
    .select({ provider: providerKey, requests: k.raw('COUNT(*)'), tokens: k.raw('SUM(input_tokens + output_tokens)'), cost: k.raw('SUM(cost)') })).sort(byCostThen('provider'));
  // The costliest sessions and chats. Rows outlive a deleted conversation (conversation_id becomes NULL) and are left out here.
  const topSessions = await inRange(k('usage as g').join('conversations as c', 'c.id', 'g.conversation_id').leftJoin('users as u', 'u.id', 'c.user_id'), 'g.ts')
    .groupBy('c.id', 'c.title', 'c.kind', 'u.display_name', 'u.username', 'u.email').orderByRaw('SUM(g.cost) DESC, c.id').limit(10)
    .select({ id: 'c.id', title: k.raw("COALESCE(NULLIF(c.title, ''), '(untitled)')"), kind: 'c.kind', user: k.raw('COALESCE(u.display_name, u.username, u.email)'), requests: k.raw('COUNT(*)'),
      tokens: k.raw('SUM(g.input_tokens + g.output_tokens)'), cost: k.raw('SUM(g.cost)') });

  const span = Math.max(to - from, 1);
  const total = (a, b) => k('usage').where('ts', '>=', a).where('ts', '<', b).first({ requests: k.raw('COUNT(*)'), tokens: k.raw('COALESCE(SUM(input_tokens + output_tokens), 0)'),
    cost: k.raw('COALESCE(SUM(cost), 0)'), activeUsers: k.raw('COUNT(DISTINCT user_id)'), estimatedRequests: k.raw('COALESCE(SUM(estimated), 0)') });
  const now = await total(from, to); const prev = from > 0 ? await total(Math.max(from - span, 0), from) : null; // "previous period" is the same length immediately before
  // Month to date and a straight-line projection to month end, whatever range is shown.
  const d = new Date(); const monthStart = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
  const monthEnd = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000); const nowSec = Math.floor(Date.now() / 1000);
  const mtd = (await total(monthStart, monthEnd)).cost; const elapsed = Math.max(nowSec - monthStart, 1);
  const month = { spent: mtd, projected: mtd * ((monthEnd - monthStart) / elapsed) };
  const unpriced = (await k('models').where('enabled', 1).where((q) => q.whereNull('input_price').orWhereNull('output_price')).select('model_id')).map((r) => r.model_id);
  const sum = (key) => byModel.reduce((a, r) => a + (r[key] || 0), 0);
  return { from, to, byModel, byUser, byDay, byDayModel, byKind, byProvider, topSessions, unpriced, month, previous: prev,
    totals: { requests: sum('requests'), inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cost: sum('cost'), activeUsers: now.activeUsers, estimatedRequests: now.estimatedRequests } };
}

// The per-request rows in a range, for download as CSV (so finance can pivot them elsewhere).
export function usageRows({ from = 0, to = Math.floor(Date.now() / 1000) + 1 } = {}) {
  const k = getKnex();
  return k('usage as g').leftJoin('users as u', 'u.id', 'g.user_id').where('g.ts', '>=', from).where('g.ts', '<', to).orderBy([{ column: 'g.ts' }, { column: 'g.id' }])
    .select({ time: isoOf(k, 'g.ts'), user: k.raw("COALESCE(u.username, u.email, '(deleted user)')"), kind: 'g.kind', provider: 'g.provider_name', model: k.raw('COALESCE(g.model_id, g.model_label)'),
      inputTokens: 'g.input_tokens', outputTokens: 'g.output_tokens', estimated: 'g.estimated', cost: 'g.cost' });
}
