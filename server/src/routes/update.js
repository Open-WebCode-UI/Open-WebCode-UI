import express from 'express';
import { defineRoutes, validate, z } from '../http.js';
import { audit } from '../audit.js';
import { updater, UpdateError } from '../updates/updater.js';

// Self-update from the release tags. Reading and checking need settings.read. Applying replaces the server's code, so it needs
// settings.write and a recent step-up, like the other changes that affect the whole server.
async function send(res, fn, status = 200) {
  try {
    const body = await fn();
    return res.status(status).json(body);
  } catch (e) {
    if (e instanceof UpdateError) return res.status(e.status).json({ error: e.code, message: e.message });
    throw e;
  }
}

export function updateRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/api/admin/update');

  route.get('/', 'settings.read', (_req, res) => send(res, () => updater.status()));

  route.post('/check', 'settings.read', (_req, res) => send(res, async () => {
    await updater.check({ force: true });
    return updater.status();
  }));

  route.post('/apply', { perm: 'settings.write', stepup: true }, (req, res) => send(res, async () => {
    const { version } = validate(z.object({ version: z.string().max(32).optional() }), req.body ?? {});
    const { job } = await updater.startApply({
      version,
      onFinish: (done) => audit(null, 'update.finished', done.to, { state: done.state, from: done.from, rolledBack: done.rolledBack, error: done.error }),
    });
    await audit(req.user.id, 'update.started', job.to, { from: job.from });
    return updater.status();
  }, 202));

  return r;
}
