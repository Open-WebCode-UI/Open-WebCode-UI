import { getDb } from './db/index.js';
import { normalizeConclusion } from './agent/conclusion.js';

// ---------- storage
export function loadMessages(convId) {
  return getDb().prepare('SELECT content FROM messages WHERE conversation_id=? AND archived=0 AND rolled_back=0 ORDER BY id').all(convId).map((r) => JSON.parse(r.content));
}
// events: checkpoints taken during the turn, each with `offset` = how many of the new messages preceded it.
export function persistFrom(convId, messages, fromIndex, events = []) {
  const db = getDb(), ins = db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)');
  db.transaction(() => {
    const before = db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE conversation_id=?').get(convId).id;
    const ids = messages.slice(fromIndex).map((m) => ins.run(convId, m.role, JSON.stringify(m)).lastInsertRowid);
    const add = db.prepare('INSERT INTO checkpoint_events (conversation_id, checkpoint_id, label, author, anchor_message_id) VALUES (?,?,?,?,?)');
    for (const e of events) add.run(convId, e.id, e.label, e.author, e.offset > 0 ? Number(ids[Math.min(e.offset, ids.length) - 1] ?? before) : before);
  })();
}
export const touch = (convId, patch = {}) => {
  const db = getDb();
  db.prepare("UPDATE conversations SET updated_at=strftime('%s','now') WHERE id=?").run(convId);
  if (patch.mode) db.prepare('UPDATE conversations SET mode=? WHERE id=?').run(patch.mode, convId);
  if (patch.modelId) db.prepare('UPDATE conversations SET model_id=? WHERE id=?').run(patch.modelId, convId);
  if ('plan' in patch) db.prepare('UPDATE conversations SET plan=? WHERE id=?').run(patch.plan, convId);
};

// ---------- checkpoint rollback
// A checkpoint remembers how far each of the project's sessions had got. Rolling back to it hides everything after that
// point from the model (the rows stay, shown grayed out); rolling forward to a later checkpoint brings them back.
export function recordCheckpointMarks(projectId, checkpointId) {
  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO checkpoint_marks (checkpoint_id, conversation_id, last_message_id)
    SELECT ?, c.id, COALESCE((SELECT MAX(id) FROM messages WHERE conversation_id=c.id), 0) FROM conversations c WHERE c.project_id=? AND c.kind='agent'`).run(checkpointId, projectId);
}
export const copyCheckpointMarks = (fromId, toId) => getDb().prepare('INSERT OR REPLACE INTO checkpoint_marks SELECT ?, conversation_id, last_message_id FROM checkpoint_marks WHERE checkpoint_id=?').run(toId, fromId);
export function rollBackMessages(checkpointId) {
  const db = getDb();
  return db.transaction(() => db.prepare('SELECT conversation_id, last_message_id FROM checkpoint_marks WHERE checkpoint_id=?').all(checkpointId).map((m) => {
    db.prepare('UPDATE messages SET rolled_back = (id > ?) WHERE conversation_id=?').run(m.last_message_id, m.conversation_id);
    return m.conversation_id;
  }))();
}

// ---------- context size (an estimate: about 4 characters per token)
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const WARN_AT = 0.6, HIGH_AT = 0.85;
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
  return { tokens, limit, pct: Math.round(pct * 100), level: pct >= HIGH_AT ? 'high' : pct >= WARN_AT ? 'warn' : 'ok' };
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
    if (m._kind === 'summary') { items.push({ kind: 'compacted', summary: m.content.replace(/^\[[^\]]*\]\s*/, ''), archived }); archived = 0; return; }
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

// Archives the live messages (kept in the database, but no longer sent to the model) and, with a summary,
// starts the new context from it. Returns how many messages were archived.
export function archiveAndRestart(convId, summary) {
  const db = getDb();
  return db.transaction(() => {
    const n = db.prepare('UPDATE messages SET archived=1 WHERE conversation_id=? AND archived=0').run(convId).changes;
    const ins = db.prepare('INSERT INTO messages (conversation_id, role, content, kind) VALUES (?,?,?,?)');
    if (summary) {
      ins.run(convId, 'user', JSON.stringify({ role: 'user', content: `${COMPACT_MARKER}\n\n${summary}` }), 'summary');
      ins.run(convId, 'assistant', JSON.stringify({ role: 'assistant', content: 'Understood. I have the summary of our earlier work and will continue from there.' }), 'summary_ack');
    } else ins.run(convId, 'user', JSON.stringify({ role: 'user', content: '[The earlier conversation was cleared. Start fresh.]' }), 'cleared'), ins.run(convId, 'assistant', JSON.stringify({ role: 'assistant', content: 'Understood. Starting fresh.' }), 'summary_ack');
    db.prepare("UPDATE conversations SET updated_at=strftime('%s','now') WHERE id=?").run(convId);
    return n;
  })();
}
export const COMMAND_RE = /^\/(compact|clear)(?:\s+([\s\S]*))?$/i;

// Conversations with a turn in progress (so a session cannot run two turns at once, and is shown as busy).
export const activeConversations = new Set();
