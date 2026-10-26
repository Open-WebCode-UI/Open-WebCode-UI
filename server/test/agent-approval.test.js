import { sqlDb } from './db-sql.js';
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, createApp, login, makeRole, addProvider, fakeAdapterFactory } from './helpers.js';

import { saveSettings, getSettings } from '../src/settings.js';

// Drives the real SSE endpoint over HTTP: the shell command is held until the client answers /api/agent/respond.
async function run(approve) {
  await freshDb(); const modelId = await addProvider();
  const script = [[{ type: 'tool_call', id: 'c1', name: 'run_command', args: { command: 'touch ran.txt' } }], [{ type: 'text', text: 'finished' }]];
  const app = createApp({ deps: { adapterFactory: fakeAdapterFactory(script) } });
  await saveSettings('general', { ...getSettings('general'), execMode: 'workspace_shell' });
  await makeRole('shelly', ['project.read', 'project.write', 'files.read', 'agent.plan', 'agent.act', 'agent.shell.run', 'provider.use']);
  const u = await login(app, { username: 'shelly1', roles: ['shelly'] });
  const p = (await u.post('/api/projects').send({ name: 'ap' })).body;
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://localhost:${server.address().port}`;
  const headers = { 'content-type': 'application/json', cookie: u.cookie, 'x-csrf-token': u.csrf };
  const res = await fetch(`${base}/api/agent/turn`, { method: 'POST', headers, body: JSON.stringify({ projectId: p.id, message: 'run it', mode: 'act', modelId }) });
  const events = []; let buf = ''; let responded = null;
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString();
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (!line.startsWith('data: ')) continue;
      const ev = JSON.parse(line.slice(6)); events.push(ev);
      if (ev.type === 'approval') {
        expect(ev.command).toBe('touch ran.txt');
        const dir = (await sqlDb().prepare('SELECT dir FROM projects WHERE id=?').get(p.id)).dir;
        expect(fs.existsSync(path.join(dir, 'ran.txt'))).toBe(false); // nothing ran before approval
        responded = await fetch(`${base}/api/agent/respond`, { method: 'POST', headers, body: JSON.stringify({ id: ev.id, value: approve }) });
      }
    }
  }
  server.close();
  return { events, responded, dir: (await sqlDb().prepare('SELECT dir FROM projects WHERE id=?').get(p.id)).dir };
}

describe('shell approval over SSE', () => {
  it('runs the command after the user approves', async () => {
    const { events, responded, dir } = await run(true);
    expect(responded.status).toBe(200);
    expect(fs.existsSync(path.join(dir, 'ran.txt'))).toBe(true);
    expect(events.find((e) => e.type === 'tool_result').result).toContain('exit=0');
    expect(events.at(-1).type).toBe('done');
  });
  it('does not run the command when the user denies', async () => {
    const { events, dir } = await run(false);
    expect(fs.existsSync(path.join(dir, 'ran.txt'))).toBe(false);
    expect(events.find((e) => e.type === 'tool_result').result).toMatch(/denied/);
  });
});
