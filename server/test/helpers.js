import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { generateSync } from 'otplib';
import { openDb, setDb, getDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { createLocalUser } from '../src/users.js';
import { setSessionCookieForTest } from './session-helper.js';
import { resetRateLimits } from '../src/ratelimit.js';
import { encrypt } from '../src/crypto.js';

export const PW = 'Correct-Horse-Battery-9';

import { config } from '../src/config.js';
export function freshDb() {
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-data-')); // isolated per test
  const db = openDb(':memory:'); setDb(db); resetRateLimits(); return db; }
export const tmpDir = (p = 'agentic-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

// Scripted fake LLM: each call to stream() consumes the next script step (array of events).
export function fakeAdapterFactory(script, seen = []) {
  return () => ({
    async listModels() { return ['fake-model']; },
    async *stream(args) {
      seen.push({ thinking: args.thinking, toolChoice: args.toolChoice, tools: (args.tools || []).map((t) => t.name), system: args.system, messages: structuredClone(args.messages) });
      const step = script.shift() || [{ type: 'text', text: 'done' }];
      for (const e of step) yield e;
      yield { type: 'done', stop: 'stop' };
    },
  });
}

export function addProvider() {
  const db = getDb();
  const pid = Number(db.prepare("INSERT INTO providers (name,type,config,secret_enc) VALUES ('p','openai','{}',?)").run(encrypt('k')).lastInsertRowid);
  return Number(db.prepare("INSERT INTO models (provider_id, model_id, label) VALUES (?, 'fake-model', 'Fake')").run(pid).lastInsertRowid);
}

export function makeRole(name, permissions) {
  const db = getDb();
  const id = Number(db.prepare('INSERT INTO roles (name) VALUES (?)').run(name).lastInsertRowid);
  for (const p of permissions) db.prepare('INSERT INTO role_permissions VALUES (?,?)').run(id, p);
  return id;
}

// Creates a user and a fully-authenticated session; returns an agent-like client with cookie + csrf header.
export function login(app, { username, roles = ['developer'], password = PW, stepup = true, source = 'local' } = {}) {
  const id = createLocalUser({ username, password, roles });
  getDb().prepare('UPDATE users SET mfa_enrolled=1 WHERE id=?').run(id);
  const { sid, csrf } = setSessionCookieForTest(id, { stepup });
  const cookie = `sid=${sid}`;
  const call = (method, url) => request(app)[method](url).set('Cookie', cookie).set('x-csrf-token', csrf);
  return { id, cookie, csrf, get: (u) => call('get', u), post: (u) => call('post', u), put: (u) => call('put', u), del: (u) => call('delete', u) };
}

export const totp = (secret) => generateSync({ secret });
export { createApp, request };
