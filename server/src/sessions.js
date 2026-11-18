import { getKnex } from './db/index.js';
import { trx } from './db/dialect.js';
import { normalizeConclusion } from './agent/conclusion.js';

// ---------- storage
const now = () => Math.floor(Date.now() / 1000);

export async function loadMessages(convId) {
  // A summary row keeps its compaction stats (for the timeline); the model never sees them.
  return (await getKnex()('messages').where({ conversation_id: convId, archived: 0, rolled_back: 0 }).orderBy('id').select('content')).map((r) => { const m = JSON.parse(r.content); delete m.compaction; return m; });
}
// events: checkpoints taken during the turn, each with `offset` = how many of the new messages preceded it.
export async function persistFrom(convId, messages, fromIndex, events = []) {
  await trx(getKnex(), async (t) => {
    const before = (await t('messages').where({ conversation_id: convId }).max({ id: 'id' }).first()).id ?? 0;
    const ids = [];
    for (const m of messages.slice(fromIndex)) { // one at a time, so ids follow the order of the conversation
      const [row] = await t('messages').insert({ conversation_id: convId, role: m.role, content: JSON.stringify(m) }).returning('id');
      ids.push(Number(row?.id ?? row));
    }
    for (const e of events) {
      await t('checkpoint_events').insert({ conversation_id: convId, checkpoint_id: e.id, label: e.label, author: e.author, anchor_message_id: e.offset > 0 ? Number(ids[Math.min(e.offset, ids.length) - 1] ?? before) : before });
    }
  });
}
export const touch = async (convId, patch = {}) => {
  await getKnex()('conversations').where({ id: convId }).update({
    updated_at: now(), ...(patch.mode && { mode: patch.mode }), ...(patch.modelId && { model_id: patch.modelId }), ...('plan' in patch && { plan: patch.plan }),
  });
};

// ---------- checkpoint rollback
// A checkpoint remembers how far each of the project's sessions had got. Rolling back to it hides everything after that
// point from the model (the rows stay, shown grayed out); rolling forward to a later checkpoint brings them back.
export async function recordCheckpointMarks(projectId, checkpointId) {
  await trx(getKnex(), async (t) => {
    const ids = (await t('conversations').where({ project_id: projectId, kind: 'agent' }).select('id')).map((c) => c.id);
    if (!ids.length) return;
    const last = new Map((await t('messages').whereIn('conversation_id', ids).groupBy('conversation_id').select('conversation_id').max({ m: 'id' })).map((r) => [r.conversation_id, r.m]));
    await t('checkpoint_marks').insert(ids.map((id) => ({ checkpoint_id: checkpointId, conversation_id: id, last_message_id: last.get(id) ?? 0 }))).onConflict(['checkpoint_id', 'conversation_id']).merge();
  });
}
export async function copyCheckpointMarks(fromId, toId) {
  const rows = await getKnex()('checkpoint_marks').where({ checkpoint_id: fromId }).select('conversation_id', 'last_message_id');
  if (rows.length) await getKnex()('checkpoint_marks').insert(rows.map((r) => ({ checkpoint_id: toId, ...r }))).onConflict(['checkpoint_id', 'conversation_id']).merge();
}
export function rollBackMessages(checkpointId) {
  return trx(getKnex(), async (t) => {
    const marks = await t('checkpoint_marks').where({ checkpoint_id: checkpointId }).select('conversation_id', 'last_message_id');
    for (const m of marks) {
      await t('messages').where({ conversation_id: m.conversation_id }).where('id', '>', m.last_message_id).update({ rolled_back: 1 });
      await t('messages').where({ conversation_id: m.conversation_id }).where('id', '<=', m.last_message_id).update({ rolled_back: 0 });
    }
    return marks.map((m) => m.conversation_id);
  });
}

// ---------- context size (an estimate: about 4 characters per token)
export const DEFAULT_CONTEXT_WINDOW = 128_000;
// Over half full the chat shows a pie; over 80% full it shows a warning to compact.
export const WARN_AT = 0.5, HIGH_AT = 0.8;
export function estimateTokens(messages, extraChars = 0) {
  let chars = extraChars;
  for (const m of messages) {
    chars += String(m.content ?? '').length + String(m.thinking ?? '').length;
    for (const c of m.toolCalls || []) chars += c.name.length + JSON.stringify(c.args ?? {}).length;
  }
  return Math.ceil(chars / 4);
}
export function contextInfo(tokens, limit = DEFAULT_CONTEXT_WINDOW) {
  const pct = tokens / limit;
  return { tokens, limit, pct: Math.round(pct * 100), level: pct > HIGH_AT ? 'high' : pct > WARN_AT ? 'warn' : 'ok' };
}

// ---------- rebuilding the conversation timeline the UI shows (what the browser builds live from the event stream)
const clip = (v, n = 1500) => (typeof v === 'string' && v.length > n ? `${v.slice(0, n)}…` : v);
export function displayArgs(name, a = {}) {
  if (name === 'write_file') return { path: a.path, bytes: Buffer.byteLength(a.content ?? '') };
  if (name === 'edit_file') return { path: a.path, old_string: clip(a.old_string), new_string: clip(a.new_string) };
  if (name === 'replace_lines' || name === 'insert_lines') return { ...a, content: clip(a.content) };
  return a;
}

export function buildTimeline(rows, { pendingPlan = null, events = [] } = {}) {
  const items = [], results = new Map();
  const msgs = rows.map((r) => ({ ...JSON.parse(r.content), _id: r.id, _kind: r.kind, _archived: !!r.archived, _rolledBack: !!r.rolled_back }));
  const made = new Map();
  for (const m of msgs) if (m.role === 'tool') { results.set(m.toolCallId, m.content); if (m.attachments?.length) made.set(m.toolCallId, m.attachments.map((a) => ({ id: a.id, name: a.name, kind: a.kind }))); }
  let archived = 0, lastPlan = null;
  const addEvents = (anchor) => { for (const e of events) if (e.anchor_message_id === anchor) items.push({ kind: 'checkpoint', cpId: e.checkpoint_id, label: e.label }); };
  let started = false;
  for (const m of msgs) {
    const from = items.length;
    if (!started) { started = true; addEvents(0); }
    buildItems(m);
    if (m._id !== undefined) addEvents(m._id);
    if (m._rolledBack) for (let i = from; i < items.length; i++) items[i].rolledBack = true;
  }
  function buildItems(m) {
    // Archived messages have left the agent's context but stay on screen, above the marker that closed them off.
    if (m._kind === 'summary_ack') return;
    if (m._kind === 'summary') { items.push({ kind: 'compacted', summary: m.content.replace(/^\[[^\]]*\]\s*/, ''), archived: m.compaction?.archived ?? archived, tokens: m.compaction?.tokens ?? null }); archived = 0; return; }
    if (m._kind === 'cleared') { items.push({ kind: 'cleared', archived }); archived = 0; return; }
    if (!m._rolledBack) archived += 1;
    if (m.role === 'user') items.push({ kind: 'user', text: m.display ?? m.content, ...(m.attachments?.length ? { attachments: m.attachments.map((a) => ({ name: a.name, kind: a.kind })) } : {}) });
    else if (m.role === 'assistant') {
      if (m.interrupted === 'empty') { /* placeholder only, nothing to show */ } else if (m.thinking || m.content) items.push({ kind: 'assistant', text: m.content || '', thinking: m.thinking || '' });
      if (m.attachments?.length) items.push({ kind: 'media', attachments: m.attachments.map((a) => ({ id: a.id, name: a.name, kind: a.kind })) }); // images the model generated
      for (const c of m.toolCalls || []) {
        const res = results.get(c.id), a = c.args || {};
        if (c.name === 'conclude') items.push({ kind: 'conclusion', c: normalizeConclusion(a) });
        else if (c.name === 'propose_plan') { const plan = { kind: 'plan', plan: String(a.plan || ''), state: 'approved' }; if (!m._rolledBack) lastPlan = plan; items.push(plan); }
        else if (c.name === 'switch_mode') items.push(a.mode === 'act' ? { kind: 'mode_request', to: 'act', reason: String(a.reason || ''), state: 'declined' } : { kind: 'mode_changed', reason: String(a.reason || '') });
        else if (c.name === 'spawn_agent') {
          const done = /finished: (\w+)/.exec(res || ''), mode = /\((plan|act) mode\)/.exec(res || '');
          items.push({ kind: 'subagent', callId: c.id, name: a.name || String(a.task || '').slice(0, 60), task: String(a.task || ''), mode: mode ? mode[1] : 'plan', downgraded: false, status: done ? done[1] : res ? 'blocked' : 'running', steps: [], summary: (res || '').replace(/^Subagent[^\n]*\n\n?/, '') });
        } else items.push({ kind: 'tool', callId: c.id, name: c.name, args: displayArgs(c.name, a), result: res, ...(made.has(c.id) ? { attachments: made.get(c.id) } : {}) });
      }
    }
  }
  // A session whose last message was cut short by Stop offers Resume again after a reload.
  if (msgs.filter((m) => !m._archived && !m._rolledBack).at(-1)?.interrupted) items.push({ kind: 'stopped' });
  // Only the most recent plan can still be waiting for approval, and only if the session says so.
  if (lastPlan && pendingPlan && lastPlan.plan === pendingPlan) lastPlan.state = 'pending';
  return items;
}

// ---------- compaction
// Renders the live conversation as plain text for the summarizer, shrinking tool output until it fits.
export function renderTranscript(messages, maxChars = 300_000) {
  const render = (cap) => messages.map((m) => {
    if (m.role === 'user') return `User: ${m.display ?? m.content}`;
    if (m.role === 'tool') return `[${m.name} result] ${String(m.content).slice(0, cap)}`;
    const calls = (m.toolCalls || []).map((c) => `[calls ${c.name} ${JSON.stringify(displayArgs(c.name, c.args)).slice(0, cap)}]`).join('\n');
    return `Assistant: ${m.content || ''}${calls ? `\n${calls}` : ''}`;
  }).join('\n\n');
  let text = '';
  for (const cap of [2000, 800, 300, 100]) { text = render(cap); if (text.length <= maxChars) return text; }
  return `[…earlier part of the session omitted…]\n${text.slice(-maxChars)}`;
}
export const COMPACT_MARKER = '[Summary of the earlier conversation, which was compacted to save context]';

// The assistant's reply that closes a summary. It tells the agent where the full text is, so it can look up an exact detail.
export const COMPACT_ACK = 'Understood. I have the summary of our earlier work and will continue from there. The full earlier conversation is archived in this session, and search_history finds exact details in it.';

// Archives the live messages (kept in the database, but no longer sent to the model) and, with a summary,
// starts the new context from it. `tokens` ({ before, after, freed }) is stored with the summary. Returns how many messages were archived.
export function archiveAndRestart(convId, summary, tokens = null) {
  return trx(getKnex(), async (t) => {
    const n = await t('messages').where({ conversation_id: convId, archived: 0 }).update({ archived: 1 });
    const add = (role, content, kind, extra = {}) => t('messages').insert({ conversation_id: convId, role, content: JSON.stringify({ role, content, ...extra }), kind });
    if (summary) {
      await add('user', `${COMPACT_MARKER}\n\n${summary}`, 'summary', { compaction: { archived: n, tokens } });
      await add('assistant', COMPACT_ACK, 'summary_ack');
    } else {
      await add('user', '[The earlier conversation was cleared. Start fresh.]', 'cleared');
      await add('assistant', 'Understood. Starting fresh.', 'summary_ack');
    }
    await t('conversations').where({ id: convId }).update({ updated_at: now() });
    return n;
  });
}
// The full text of the earlier conversation: messages that were archived. The agent searches it with search_history.
export async function hasArchivedMessages(convId) {
  return !!(await getKnex()('messages').where({ conversation_id: convId, archived: 1, rolled_back: 0 }).first('id'));
}
export async function searchArchive(convId, query, { limit = 8, radius = 160 } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return 'Give some text to search for.';
  const rows = await getKnex()('messages').where({ conversation_id: convId, archived: 1, rolled_back: 0 }).whereIn('role', ['user', 'assistant', 'tool']).orderBy('id').select('role', 'content');
  const hits = []; let total = 0;
  rows.forEach((r, i) => {
    const m = JSON.parse(r.content), text = String(m.display ?? m.content ?? '');
    const at = text.toLowerCase().indexOf(q);
    if (at < 0) return;
    total += 1;
    if (hits.length < limit) hits.push(`Archived message ${i + 1} (${r.role}): …${text.slice(Math.max(0, at - radius), at + q.length + radius).replace(/\s+/g, ' ')}…`);
  });
  if (!total) return `No match for "${String(query).trim()}" in the earlier conversation.`;
  return `${total} match${total === 1 ? '' : 'es'} in the earlier conversation${total > hits.length ? `, showing the first ${hits.length}` : ''}:\n${hits.join('\n')}`;
}
export const COMMAND_RE = /^\/(compact|clear)(?:\s+([\s\S]*))?$/i;

// Conversations with a turn in progress (so a session cannot run two turns at once, and is shown as busy).
export const activeConversations = new Set();
