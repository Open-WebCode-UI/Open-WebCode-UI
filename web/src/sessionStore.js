import { useSyncExternalStore } from 'react';
import { get, post, put, del, streamPost } from './api.js';
import { approvals } from './approvalStore.js';

// Agent sessions live here, outside any React component, so navigating away from the IDE (to Help, Profile, …) does not
// lose them: a turn that is still streaming keeps filling its session, and coming back shows it exactly as it was.
// One live session per project; saved sessions come back from the server (GET /api/sessions/:id).
const live = new Map();               // projectId -> session
const subs = new Set();
const bus = new Map();                // event name -> callbacks (file changes, checkpoints, shell commands, …)
const BLANK = Object.freeze({ convId: null, title: '', items: [], mode: 'plan', modelId: null, pendingPlan: '', busy: false, phase: null, context: null, draft: '', question: null, loaded: false, error: '', webSearch: false });
let seq = 0;
const nid = () => `i${++seq}`;
const notify = () => subs.forEach((f) => f());
const read = (pid) => live.get(pid) ?? BLANK;
const upd = (pid, patch) => { live.set(pid, { ...read(pid), ...(typeof patch === 'function' ? patch(read(pid)) : patch) }); notify(); };
const push = (pid, item) => upd(pid, (s) => ({ items: [...s.items, { id: nid(), ...item }] }));
const patchItem = (pid, match, fn) => upd(pid, (s) => ({ items: s.items.map((x) => (match(x) ? fn(x) : x)) }));
const emitBus = (name, ...args) => (bus.get(name) || []).forEach((cb) => { try { cb(...args); } catch { /* a listener must not break the stream */ } });
const aborts = new Map();             // slot -> AbortController of the running turn
const holders = new Map();            // slot -> { key } of the running turn; the key follows the session when it moves to the background
let bgSeq = 0;
// A session that is still running when the user starts another moves to a background slot and keeps streaming there.
function detach(pid) {
  const k = `bg:${++bgSeq}`, h = holders.get(pid), ctl = aborts.get(pid), cur = read(pid);
  live.set(k, cur);
  if (h) { holders.delete(pid); h.key = k; holders.set(k, h); }
  if (ctl) { aborts.delete(pid); aborts.set(k, ctl); }
  live.set(pid, { ...BLANK, mode: cur.mode, modelId: cur.modelId, loaded: true });
  notify();
}
const backgroundKey = (id) => [...live.keys()].find((k) => typeof k === 'string' && live.get(k).convId === id);

// thinking/text stream into the latest agent reply; a tool call closes it, so later text starts a fresh reply
function stream(pid, field, text) {
  upd(pid, (s) => {
    const last = s.items[s.items.length - 1];
    if (last?.kind === 'assistant') return { items: [...s.items.slice(0, -1), { ...last, [field]: (last[field] || '') + text }] };
    return { items: [...s.items, { id: nid(), kind: 'assistant', thinking: '', text: '', [field]: text }] };
  });
}
// Events from a subagent fold into its own card (they carry the id of the spawn_agent call).
function subEvent(pid, id, e) {
  if (e.type === 'file_changed') { emitBus('file_changed', e.path); return; }
  if (e.type === 'thinking' || e.type === 'approval') return;
  patchItem(pid, (x) => x.kind === 'subagent' && x.callId === id, (x) => {
    const steps = [...x.steps];
    if (e.type === 'text') { const l = steps[steps.length - 1]; if (l?.kind === 'text') steps[steps.length - 1] = { ...l, text: l.text + e.text }; else steps.push({ kind: 'text', text: e.text }); }
    else if (e.type === 'tool_start') steps.push({ kind: 'tool', callId: e.id, name: e.name, args: e.args });
    else if (e.type === 'tool_result') { const i = steps.findIndex((t) => t.kind === 'tool' && t.callId === e.id); if (i >= 0) steps[i] = { ...steps[i], result: e.result }; }
    else if (e.type === 'checkpoint') steps.push({ kind: 'checkpoint', cpId: e.id, label: e.label });
    return { ...x, steps };
  });
}
// While the model is still writing a tool call, its path / file content / command arrive piece by piece and fill a live card.
// The finished call (tool_start) replaces the streamed text with the real arguments. Display text is capped so a huge file stays cheap to render.
const STREAM_CAP = 2_000_000;
const FILE_TOOLS = new Set(['write_file', 'edit_file', 'replace_lines', 'delete_lines', 'insert_lines']);
// The Explorer and Editor follow file-writing calls through these bus events (see pages/IDE.jsx).
function toolProgress(pid, ev, project) {
  if (ev.name === 'propose_plan') { // the plan fills its own card as it is written; the 'plan' event later finalizes it
    const text = ev.fields?.plan || '';
    upd(pid, (s) => {
      const i = s.items.findIndex((x) => x.kind === 'plan' && x.callId === ev.id);
      if (i < 0) return { items: [...s.items, { id: nid(), kind: 'plan', callId: ev.id, plan: text, state: 'writing' }] };
      if (!text || s.items[i].state !== 'writing') return {};
      return { items: s.items.map((x, j) => (j === i ? { ...x, plan: x.plan + text } : x)) };
    });
    return;
  }
  if (HIDDEN_TOOLS.has(ev.name)) return;
  upd(pid, (s) => {
    const i = s.items.findIndex((x) => x.kind === 'tool' && x.callId === ev.id);
    const cur = i >= 0 ? s.items[i] : { id: nid(), kind: 'tool', callId: ev.id, name: ev.name, args: {}, stream: {}, lines: 0, since: Date.now() };
    if (!cur.stream) return {}; // the finished call already arrived
    const stream = { ...cur.stream };
    let lines = cur.lines;
    for (const [k, v] of Object.entries(ev.fields || {})) {
      stream[k] = ((stream[k] || '') + v).slice(-STREAM_CAP);
      if (k === 'content' || k === 'new_string') lines += (v.match(/\n/g) || []).length;
    }
    const next = { ...cur, stream, lines, closed: [...new Set([...(cur.closed || []), ...(ev.closed || [])])], args: { path: stream.path, command: stream.command } };
    return { items: i >= 0 ? s.items.map((x, j) => (j === i ? next : x)) : [...s.items, next] };
  });
  const it = read(pid).items.find((x) => x.kind === 'tool' && x.callId === ev.id);
  if (it?.stream && FILE_TOOLS.has(ev.name)) emitBus('file_stream', { project, id: ev.id, name: ev.name, stream: it.stream, closed: it.closed });
}
// Terminal tools get their own cards, so they are not shown as generic steps.
const HIDDEN_TOOLS = new Set(['conclude', 'switch_mode', 'propose_plan', 'spawn_agent']);

const lastEventAt = new Map(); // slot -> time of the latest event, to tell "working" from "quiet"
function handle(pid, ev, project = pid) {
  lastEventAt.set(pid, Date.now());
  switch (ev.type) {
    case 'start': upd(pid, { convId: ev.conversationId }); emitBus('sessions_changed', project); break;
    case 'phase': upd(pid, { phase: ev.phase === 'prefill' ? { name: 'prefill', since: Date.now(), tokens: ev.tokens, etaMs: ev.etaMs } : { name: ev.phase } }); break;
    case 'text': stream(pid, 'text', ev.text); break;
    case 'thinking': stream(pid, 'thinking', ev.text); break;
    case 'skill': push(pid, { kind: 'skill', name: ev.name }); break;
    case 'media': push(pid, { kind: 'media', attachments: ev.attachments }); break;                 // an image the model generated
    case 'tool_progress': toolProgress(pid, ev, project); break;
    case 'tool_start':
      if (FILE_TOOLS.has(ev.name)) emitBus('file_stream_end', { project, id: ev.id });
      if (!HIDDEN_TOOLS.has(ev.name)) {
        if (read(pid).items.some((x) => x.kind === 'tool' && x.callId === ev.id)) patchItem(pid, (x) => x.kind === 'tool' && x.callId === ev.id, ({ stream, lines, ...x }) => ({ ...x, args: ev.args }));
        else push(pid, { kind: 'tool', callId: ev.id, name: ev.name, args: ev.args });
      }
      if (ev.name === 'run_command') emitBus('command', { type: 'start', id: ev.id, command: ev.args?.command });
      break;
    case 'tool_result':
      patchItem(pid, (x) => x.kind === 'tool' && x.callId === ev.id, (x) => ({ ...x, result: ev.result, ...(ev.attachments?.length ? { attachments: ev.attachments } : {}) }));
      if (ev.name === 'run_command') emitBus('command', { type: 'result', id: ev.id, result: ev.result });
      if (FILE_TOOLS.has(ev.name) && String(ev.result).startsWith('Error')) emitBus('file_changed'); // the live preview never reached disk: put the editor back
      break;
    case 'checkpoint': push(pid, { kind: 'checkpoint', cpId: ev.id, label: ev.label }); emitBus('checkpoint'); break;
    case 'file_changed': emitBus('file_changed', ev.path); break;
    case 'subagent_start': push(pid, { kind: 'subagent', callId: ev.id, name: ev.name, task: ev.task, mode: ev.mode, downgraded: ev.downgraded, status: 'running', steps: [], summary: '' }); break;
    case 'subagent_event': subEvent(pid, ev.id, ev.event); break;
    case 'subagent_done': patchItem(pid, (x) => x.kind === 'subagent' && x.callId === ev.id, (x) => ({ ...x, status: ev.status, summary: ev.summary })); break;
    case 'plan':
      upd(pid, { pendingPlan: ev.plan });
      if (read(pid).items.some((x) => x.kind === 'plan' && x.state === 'writing')) patchItem(pid, (x) => x.kind === 'plan' && x.state === 'writing', (x) => ({ ...x, plan: ev.plan, state: 'pending' }));
      else push(pid, { kind: 'plan', plan: ev.plan, state: 'pending' });
      break;
    case 'conclusion': push(pid, { kind: 'conclusion', c: ev }); break;
    case 'mode_request': push(pid, { kind: 'mode_request', to: ev.to, reason: ev.reason, state: 'pending' }); break;
    case 'mode_changed': upd(pid, { mode: ev.to }); push(pid, { kind: 'mode_changed', reason: ev.reason }); break;
    case 'approval': approvals.push({ id: ev.id, command: ev.command, agent: ev.agent }); break;
    case 'question': upd(pid, { question: { id: ev.id, question: ev.question, options: ev.options || [], multiple: !!ev.multiple } }); break;
    case 'context': upd(pid, { context: { tokens: ev.tokens, limit: ev.limit, pct: ev.pct, level: ev.level } }); break;
    case 'compacting': push(pid, { kind: 'compacting' }); break;
    // After compaction or /clear the old messages leave the agent's context but stay on screen, above the marker.
    case 'compacted': upd(pid, { items: [...read(pid).items.filter((x) => x.kind !== 'compacting'), { id: nid(), kind: 'compacted', summary: ev.summary, archived: ev.archived }] }); break;
    case 'cleared': push(pid, { kind: 'cleared', archived: ev.archived }); break;
    case 'notice': push(pid, { kind: 'notice', text: ev.text }); break;
    case 'status': push(pid, { kind: 'status', status: ev }); break;
    case 'memory_saved': push(pid, { kind: 'memory', scope: ev.scope, text: ev.text }); break;
    case 'error': push(pid, { kind: 'error', text: ev.message }); break;
    default: break;
  }
}

export const sessions = {
  get: read,
  lastEventAt: (pid) => lastEventAt.get(pid) ?? 0,
  emit: emitBus,
  subscribe(f) { subs.add(f); return () => subs.delete(f); },
  on(name, cb) { const set = bus.get(name) || new Set(); set.add(cb); bus.set(name, set); return () => set.delete(cb); },

  setDraft: (pid, draft) => upd(pid, { draft }),
  setMode: (pid, mode) => upd(pid, { mode }),
  setModel: (pid, modelId) => upd(pid, { modelId }),
  setWebSearch: (pid, webSearch) => upd(pid, { webSearch }),
  resolveItem: (pid, id, state) => patchItem(pid, (x) => x.id === id, (x) => ({ ...x, state })),
  approvePlan: (pid) => patchItem(pid, (x) => x.kind === 'plan' && x.state === 'pending', (x) => ({ ...x, state: 'approved' })),
  clearQuestion: (pid) => upd(pid, { question: null }),

  // Starts a turn. The returned promise resolves when the stream ends; the session keeps updating even if no component is mounted.
  async send(pid, { text, mode, plan = '', modelId, thinking, effort, webSearch, resume = false, attachments = [] }) {
    const s = read(pid);
    if (s.busy || !text.trim()) return false;
    upd(pid, { items: read(pid).items.filter((x) => x.kind !== 'stopped'), busy: true, phase: { name: 'sending', since: Date.now() }, mode, draft: '', error: '', ...(modelId ? { modelId } : {}), ...(mode === 'act' ? { pendingPlan: '' } : {}) });
    push(pid, { kind: 'user', text, ...(attachments.length ? { attachments: attachments.map((a) => ({ name: a.name, kind: a.kind })) } : {}) });
    const ctl = new AbortController(), turn = { key: pid }; aborts.set(pid, ctl); holders.set(pid, turn);
    try {
      await streamPost('/api/agent/turn', { projectId: pid, conversationId: read(pid).convId ?? undefined, message: text, mode, modelId: modelId || undefined, approvedPlan: plan || undefined, thinking, effort, webSearch, resume: resume || undefined, attachments: attachments.length ? attachments.map((a) => a.id) : undefined }, (ev) => handle(turn.key, ev, pid), ctl.signal);
    } catch (e) {
      if (e.name === 'AbortError') push(turn.key, { kind: 'stopped' });
      else push(turn.key, { kind: 'error', text: e.body?.error === 'no_model_available' ? 'No AI model is available. Ask an administrator to configure one.' : e.body?.error === 'session_busy' ? 'This session is already running a turn.' : e.body?.permission ? `Missing permission: ${e.body.permission}` : e.body?.message || 'Request failed' });
    } finally {
      const k = turn.key; aborts.delete(k); holders.delete(k);
      read(k).items.filter((x) => x.stream && x.result === undefined && FILE_TOOLS.has(x.name)).forEach((x) => emitBus('file_stream_end', { project: pid, id: x.callId }));
      if (k === pid) upd(pid, (s) => ({ busy: false, phase: null, question: null, items: s.items.filter((x) => !(x.stream && x.result === undefined) && x.state !== 'writing') })); // drop half-written calls left by Stop or an error else { live.delete(k); notify(); }
      approvals.clear();
      emitBus('turn_end', pid); emitBus('sessions_changed', pid);
    }
    return true;
  },
  stop(pid) { aborts.get(pid)?.abort(); },
  dismissStopped: (pid) => upd(pid, (s) => ({ items: s.items.filter((x) => x.kind !== 'stopped') })),
  // Running sessions other than the visible one.
  backgroundIds: () => [...live.keys()].filter((k) => typeof k === 'string').map((k) => live.get(k).convId),

  newSession(pid) { if (read(pid).busy) detach(pid); upd(pid, { ...BLANK, mode: read(pid).mode, modelId: read(pid).modelId, loaded: true }) /* web search starts off in every new session */; return true; },
  // Loads a saved session so the user can carry on where they left off.
  async open(pid, id) {
    if (read(pid).busy && read(pid).convId !== id) return false;
    const bg = backgroundKey(id);
    if (bg) { // that session is still running: bring it back as it is, rather than loading a partial copy
      const h = holders.get(bg), ctl = aborts.get(bg);
      live.set(pid, live.get(bg)); live.delete(bg); holders.delete(bg); aborts.delete(bg);
      if (h) { h.key = pid; holders.set(pid, h); } if (ctl) aborts.set(pid, ctl);
      notify(); return true;
    }
    const s = await get(`/api/sessions/${id}`);
    upd(pid, { convId: s.id, title: s.title, items: s.items.map((i) => ({ id: nid(), ...i })), mode: s.mode, modelId: s.modelId ?? read(pid).modelId, webSearch: !!s.webSearch, pendingPlan: s.pendingPlan || '', context: s.context, question: null, loaded: true, error: '' });
    return true;
  },
  // After a checkpoint restore changed which messages count: reload the open session from the server.
  async reload(pid) { const s = read(pid); if (s.convId && !s.busy) await sessions.open(pid, s.convId).catch(() => {}); },
  // On first use of a project in this page load, reopen the most recent session (so a reload does not look like lost work).
  async resume(pid) {
    const s = read(pid); if (s.loaded || s.busy || s.convId) return;
    upd(pid, { loaded: true });
    try { const list = await get(`/api/sessions?projectId=${pid}`); if (list.length && !read(pid).convId && !read(pid).busy && !read(pid).items.length) await sessions.open(pid, list[0].id); } catch { /* sessions are optional */ }
  },
  async remove(pid, id) { await del(`/api/sessions/${id}`); if (read(pid).convId === id) sessions.newSession(pid); emitBus('sessions_changed', pid); },
  // Deletes the given sessions (or every session of the project). Resolves to { deleted, skipped }: running sessions are kept.
  async removeMany(pid, { ids, all = false }) {
    const r = await post('/api/sessions/bulk-delete', { projectId: pid, ...(all ? { all: true } : { ids }) });
    if (r.deletedIds.includes(read(pid).convId)) sessions.newSession(pid);
    emitBus('sessions_changed', pid);
    return r;
  },
  async rename(pid, id, title) { const r = await put(`/api/sessions/${id}`, { title }); if (read(pid).convId === id) upd(pid, { title: r.title }); emitBus('sessions_changed', pid); },
  resetAll() { live.clear(); aborts.forEach((c) => c.abort()); aborts.clear(); bus.clear(); notify(); },
};

export const useSession = (pid) => useSyncExternalStore(sessions.subscribe, () => read(pid));
