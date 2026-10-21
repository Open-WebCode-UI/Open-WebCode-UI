import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPty } from './pty.js';

const MAX_BUFFER = 200_000;                       // scrollback replayed to a newly attached viewer
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\r(?!\n)/g;
export const clean = (s) => s.replace(ANSI, '').replace(/\r\n/g, '\n');

// Scrubbed environment: the shell never inherits the server's secrets (session key, API keys, ...).
const baseEnv = (cwd) => ({ PATH: process.env.PATH, HOME: cwd, TERM: 'xterm-256color', LANG: process.env.LANG?.includes('UTF-8') ? process.env.LANG : 'en_US.UTF-8', CI: '' });
const userShell = () => (fs.existsSync('/bin/bash') ? { file: '/bin/bash', args: ['--noprofile', '--norc', '-i'], env: { PS1: '\\[\\e[32m\\]\\W\\[\\e[0m\\] \\$ ' } } : { file: '/bin/sh', args: ['-i'], env: { PS1: '$ ' } });

export class TerminalSession {
  constructor({ id, userId, projectId, kind, cwd, cols = 100, rows = 28 }, ptyApi = loadPty()) {
    Object.assign(this, { id, userId, projectId, kind, cwd, cols, rows, subs: new Set(), buffer: '', exited: false, exitCode: null, createdAt: Date.now(), lastActive: Date.now(), queue: Promise.resolve(), quiet: false });
    const sh = kind === 'agent' ? { file: '/bin/sh', args: [], env: { PS1: '', PS2: '' } } : userShell();
    this.pty = ptyApi.spawn(sh.file, sh.args, { name: 'xterm-256color', cols, rows, cwd, env: { ...baseEnv(cwd), ...sh.env } });
    this.pty.onData((d) => this.#data(d));
    this.dataTaps = new Set(); this.exitHooks = new Set();
    this.pty.onExit(({ exitCode }) => { this.exited = true; this.exitCode = exitCode; this.#emit({ type: 'exit', code: exitCode }); for (const h of [...this.exitHooks]) h(exitCode); });
  }
  #data(d) {
    this.lastActive = Date.now();
    for (const t of this.dataTaps) t(d);
    if (this.quiet) return;
    this.buffer = (this.buffer + d).slice(-MAX_BUFFER);
    this.#emit({ type: 'output', data: d });
  }
  // Shows text to viewers (and in the replayed scrollback) without it reaching the command-output taps.
  #show(text) { this.buffer = (this.buffer + text).slice(-MAX_BUFFER); this.#emit({ type: 'output', data: text }); }
  #emit(msg) { for (const s of this.subs) { try { s(msg); } catch { /* subscriber went away */ } } }
  attach(fn) { this.subs.add(fn); if (this.buffer) fn({ type: 'output', data: this.buffer }); if (this.exited) fn({ type: 'exit', code: this.exitCode }); return () => this.subs.delete(fn); }
  write(data) { if (this.exited) return; this.lastActive = Date.now(); this.pty.write(data); }
  resize(cols, rows) { cols = Math.max(20, Math.min(400, cols | 0)); rows = Math.max(5, Math.min(200, rows | 0)); if (this.exited) return; this.cols = cols; this.rows = rows; try { this.pty.resize(cols, rows); } catch { /* already gone */ } }
  kill() { if (!this.exited) { try { this.pty.kill(); } catch { /* already gone */ } } this.exited = true; this.#emit({ type: 'exit', code: this.exitCode ?? -1 }); this.subs.clear(); if (this.tmp) fs.rmSync(this.tmp, { recursive: true, force: true }); }

  // Agent sessions only. Runs `command` inside this persistent shell (so cd / exported variables carry over between
  // commands) and returns its exit status and output. Commands are queued; the viewer sees them run live.
  async init() {
    this.quiet = true; this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sh-')); fs.chmodSync(this.tmp, 0o700);
    const ready = `__READY_${crypto.randomBytes(6).toString('hex')}__`;
    await new Promise((resolve, reject) => {
      let acc = ''; const tap = (d) => { acc += d; if (new RegExp(`(^|\\n)${ready}\\r?\\n`).test(acc)) { this.dataTaps.delete(tap); resolve(); } };
      this.dataTaps.add(tap); setTimeout(() => reject(new Error('shell did not start')), 8000).unref();
      this.pty.write(`stty -echo 2>/dev/null; PS1=; PS2=; printf '\\n${ready}\\n'\n`);
    });
    this.quiet = false;
  }
  run(command, { timeoutSec = 60, outputCap = 100_000 } = {}) {
    const job = this.queue.then(() => this.#run(command, timeoutSec, outputCap));
    this.queue = job.catch(() => {});
    return job;
  }
  #run(command, timeoutSec, outputCap) {
    if (this.exited) return Promise.resolve({ code: -1, output: 'The shell is not running.', timedOut: false, restart: true });
    const nonce = crypto.randomBytes(8).toString('hex'), script = path.join(this.tmp, `${nonce}.sh`);
    this.#show(`\x1b[1;36m$ ${command.replace(/\r?\n/g, '\r\n> ')}\x1b[0m\r\n`); // the shell has echo off, so the viewer would otherwise see output without the command
    fs.writeFileSync(script, `${command}\n`, { mode: 0o600 }); // sourced from a file: sidesteps the tty's line-length limit
    const start = `__S_${nonce}__`, end = new RegExp(`\\n__E_${nonce}_(-?\\d+)__\\r?\\n`);
    return new Promise((resolve) => {
      let acc = '', started = false, out = '', truncated = false, done = false, timedOut = false, killTimer;
      // Collects what has been printed so far. While running, the last few bytes are held back in case they are the start
      // of the end marker; `final` (the shell exited) releases them.
      const collect = (final) => {
        const m = end.exec(acc);
        const chunk = clean(m ? acc.slice(0, m.index) : final ? acc : acc.slice(0, Math.max(0, acc.length - 40)));
        if (!truncated) { out += chunk.slice(out.length).slice(0, Math.max(0, outputCap - out.length)); if (chunk.length > outputCap) truncated = true; }
        return m;
      };
      // A command that ends the shell itself (`exit 3`) will never print the end marker: report its status right away.
      const onExit = (code) => { if (started) collect(true); out += '\n[shell exited]'; finish(code); };
      const finish = (code) => {
        if (done) return; done = true; this.exitHooks.delete(onExit); this.dataTaps.delete(tap); clearTimeout(timer); clearTimeout(killTimer); fs.rmSync(script, { force: true });
        resolve({ code, output: out + (truncated ? '\n[output truncated]' : ''), timedOut, restart: false });
      };
      const tap = (d) => {
        acc += d;
        if (!started) { const i = acc.indexOf(`\n${start}`); if (i < 0) return; started = true; acc = acc.slice(i + start.length + 1).replace(/^\r?\n/, ''); }
        const m = collect(false);
        if (m) finish(Number(m[1]));
      };
      this.dataTaps.add(tap); this.exitHooks.add(onExit);
      const timer = setTimeout(() => {
        timedOut = true; this.pty.write('\x03'); // interrupt the foreground job; if the shell does not come back, kill it
        killTimer = setTimeout(() => { this.kill(); finish(-1); }, 3000);
      }, timeoutSec * 1000);
      this.pty.write(`printf '\\n${start}\\n'; . '${script}'; printf '\\n__E_${nonce}_%d__\\n' "$?"\n`);
    });
  }
}

export class TerminalManager {
  constructor({ idleMs = 30 * 60_000, maxPerUser = 6, maxTotal = 60, ptyApi } = {}) {
    Object.assign(this, { idleMs, maxPerUser, maxTotal, ptyApi, sessions: new Map(), creating: new Map() });
    this.sweeper = setInterval(() => this.sweep(), 60_000); this.sweeper.unref();
  }
  find(userId, projectId, kind) { for (const s of this.sessions.values()) if (s.userId === userId && s.projectId === projectId && s.kind === kind && !s.exited) return s; return null; }
  get(id) { const s = this.sessions.get(id); return s && !s.exited ? s : null; }
  list(userId, projectId) { return [...this.sessions.values()].filter((s) => s.userId === userId && s.projectId === projectId && !s.exited); }
  async create({ userId, projectId, kind, cwd, cols, rows }) {
    const key = `${userId}:${projectId}:${kind}`;
    const existing = this.find(userId, projectId, kind); if (existing) return existing;
    if (this.creating.has(key)) return this.creating.get(key); // concurrent callers share one new session
    const p = (async () => {
      if ([...this.sessions.values()].filter((s) => s.userId === userId && !s.exited).length >= this.maxPerUser) throw Object.assign(new Error('too_many_terminals'), { status: 429 });
      if (this.sessions.size >= this.maxTotal) this.sweep(true);
      const s = new TerminalSession({ id: crypto.randomBytes(16).toString('hex'), userId, projectId, kind, cwd, cols, rows }, this.ptyApi || loadPty());
      this.sessions.set(s.id, s);
      s.pty.onExit(() => setTimeout(() => this.sessions.delete(s.id), 5000).unref());
      if (kind === 'agent') await s.init().catch((e) => { s.kill(); this.sessions.delete(s.id); throw e; });
      return s;
    })().finally(() => this.creating.delete(key));
    this.creating.set(key, p); return p;
  }
  async agentRun({ userId, projectId, cwd, command, timeoutSec, outputCap }) {
    let s = await this.create({ userId, projectId, kind: 'agent', cwd });
    let r = await s.run(command, { timeoutSec, outputCap });
    if (r.restart) { s = await this.create({ userId, projectId, kind: 'agent', cwd }); r = await s.run(command, { timeoutSec, outputCap }); }
    return r;
  }
  close(id) { const s = this.sessions.get(id); if (s) { s.kill(); this.sessions.delete(id); } }
  killWhere(pred) { for (const [id, s] of this.sessions) if (pred(s)) { s.kill(); this.sessions.delete(id); } }
  killAll() { this.killWhere(() => true); }
  killForProject(projectId) { this.killWhere((s) => s.projectId === projectId); }
  killForUser(userId) { this.killWhere((s) => s.userId === userId); }
  sweep(force = false) { const now = Date.now(); this.killWhere((s) => s.exited || (!s.subs.size && now - s.lastActive > this.idleMs) || (force && !s.subs.size && now - s.lastActive > 60_000)); }
}
export const terminals = new TerminalManager();
