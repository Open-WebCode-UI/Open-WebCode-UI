import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { generateSync } from 'otplib';
import { openDb, setDb, getKnex } from '../src/db/index.js';
import { sqlDb } from './db-sql.js';
import { createApp } from '../src/app.js';
import { createLocalUser } from '../src/users.js';
import { setSessionCookieForTest } from './session-helper.js';
import { resetRateLimits } from '../src/ratelimit.js';
import { encrypt } from '../src/crypto.js';

export const PW = 'Correct-Horse-Battery-9';

import { config } from '../src/config.js';
export async function freshDb() {
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-data-')); // isolated per test
  const db = await openDb(':memory:'); await setDb(db); resetRateLimits(); return db; }
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

export async function addProvider() {
  const db = sqlDb();
  const pid = Number((await db.prepare("INSERT INTO providers (name,type,config,secret_enc) VALUES ('p','openai','{}',?)").run(encrypt('k'))).lastInsertRowid);
  return Number((await db.prepare("INSERT INTO models (provider_id, model_id, label) VALUES (?, 'fake-model', 'Fake')").run(pid)).lastInsertRowid);
}

export async function makeRole(name, permissions) {
  const db = sqlDb();
  const id = Number((await db.prepare('INSERT INTO roles (name) VALUES (?)').run(name)).lastInsertRowid);
  for (const p of permissions) (await db.prepare('INSERT INTO role_permissions VALUES (?,?)').run(id, p));
  return id;
}

// Creates a user and a fully-authenticated session; returns an agent-like client with cookie + csrf header.
export async function login(app, { username, roles = ['developer'], password = PW, stepup = true, source = 'local' } = {}) {
  const id = await createLocalUser({ username, password, roles });
  await getKnex()('users').where({ id }).update({ mfa_enrolled: 1 });
  const { sid, csrf } = await setSessionCookieForTest(id, { stepup });
  const cookie = `sid=${sid}`;
  const call = (method, url) => request(app)[method](url).set('Cookie', cookie).set('x-csrf-token', csrf);
  return { id, cookie, csrf, get: (u) => call('get', u), post: (u) => call('post', u), put: (u) => call('put', u), del: (u) => call('delete', u) };
}

export const totp = (secret) => generateSync({ secret });
export { createApp, request };
