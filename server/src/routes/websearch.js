import express from 'express';
import { defineRoutes, validate, z } from '../http.js';
import { audit } from '../audit.js';
import { webSearchAllowed, webSearchConfigured, userWebSearchOn, setUserWebSearch } from '../websearch.js';

export function webSearchRouter({ deps = {} } = {}) {
  const r = express.Router();
  const route = defineRoutes(r, '/api');

  // What the UI needs: the tenant switch, whether a search backend exists, and the user's own switch.
  route.get('/web-search', 'websearch.use', async (req, res) => {
    res.json({ allowed: webSearchAllowed(), configured: webSearchConfigured(deps.backend), enabled: await userWebSearchOn(req.user.id) });
  });
  route.put('/web-search/settings', 'websearch.use', async (req, res) => {
    const { enabled } = validate(z.object({ enabled: z.boolean() }).strict(), req.body);
    await setUserWebSearch(req.user.id, enabled);
    await audit(req.user.id, 'websearch.toggle', null, { enabled });
    res.json({ allowed: webSearchAllowed(), configured: webSearchConfigured(deps.backend), enabled });
  });
  return r;
}
