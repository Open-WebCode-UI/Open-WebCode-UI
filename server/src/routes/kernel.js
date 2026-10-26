import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { defineRoutes, fail, validate, z } from '../http.js';
import { audit } from '../audit.js';
import { shellEnabled } from '../terminal/ws.js';
import { kernels } from '../terminal/kernel.js';
import { resolveInJail, relFrom, JailError } from '../workspace/jail.js';
import { getProject } from './projects.js';

// Runs notebook cells on the server in a persistent Python process. This executes arbitrary code as the server's OS account, so it is
// gated exactly like the interactive terminal: shell mode on, the terminal.use permission, and recent re-verification to start a run.
export function kernelRouter({ manager = kernels } = {}) {
  const r = express.Router();
  const route = defineRoutes(r, '/api');
  const Body = z.object({ projectId: z.number().int(), path: z.string().min(1).max(500).regex(/\.ipynb$/i) });
  const target = async (req, b) => {
    if (!shellEnabled()) fail(403, 'shell_disabled', { message: 'The administrator has not enabled shell access.' });
    const p = await getProject({ params: { id: b.projectId }, user: req.user });
    try {
      const abs = resolveInJail(p.dir, b.path);
      return { p, file: relFrom(p.dir, abs), cwd: fs.statSync(path.dirname(abs)).isDirectory() ? path.dirname(abs) : p.dir }; // like Jupyter, relative paths start in the notebook's folder
    } catch (e) { if (e instanceof JailError) fail(400, 'invalid_path'); throw e; }
  };

  route.post('/terminal/kernel/run', { perm: 'terminal.use', stepup: true }, async (req, res) => {
    const b = validate(Body.extend({ code: z.string().max(200_000) }), req.body);
    const { p, file, cwd } = await target(req, b);
    let k; try { k = manager.create(req.user.id, p.id, file, cwd); } catch (e) { if (e.status === 429) fail(429, 'too_many_kernels'); throw e; }
    await audit(req.user.id, 'kernel.run', p.name, { path: file });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
    // A client that goes away mid-run must not leave the cell running unseen.
    let finished = false; res.on('close', () => { if (!finished) k.interrupt(); });
    await k.run(b.code, send); finished = true; res.end();
  });
  route.post('/terminal/kernel/interrupt', 'terminal.use', async (req, res) => {
    const b = validate(Body, req.body); const { p, file } = await target(req, b);
    res.json({ interrupted: manager.get(req.user.id, p.id, file)?.interrupt() ?? false });
  });
  route.post('/terminal/kernel/restart', 'terminal.use', async (req, res) => {
    const b = validate(Body, req.body); const { p, file } = await target(req, b);
    manager.restart(req.user.id, p.id, file); await audit(req.user.id, 'kernel.restart', p.name, { path: file });
    res.json({ ok: true });
  });
  return r;
}
