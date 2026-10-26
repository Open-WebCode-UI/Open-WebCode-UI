import express from 'express';
import { defineRoutes, validate, z } from '../http.js';
import { usageReport, usageRows } from '../usage.js';

const range = z.object({ from: z.coerce.number().int().min(0).optional(), to: z.coerce.number().int().min(0).optional() });
// A cell that starts with = + - @ is read as a formula by spreadsheets, so it is prefixed to stay text.
const cell = (v) => { const t = String(v ?? ''); const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t; return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };

export function reportsRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/api');
  // Usage and spend for an optional date range, as unix seconds: by model, user, kind, provider, day, and the costliest sessions.
  route.get('/reports/usage', 'report.read', async (req, res) => res.json(await usageReport(validate(range, req.query))));
  // The same range, one row per model request.
  route.get('/reports/usage.csv', 'report.read', async (req, res) => {
    const rows = await usageRows(validate(range, req.query)); const cols = ['time', 'user', 'kind', 'provider', 'model', 'inputTokens', 'outputTokens', 'estimated', 'cost'];
    res.type('text/csv').attachment('usage.csv').send([cols.join(','), ...rows.map((x) => cols.map((c) => cell(x[c])).join(','))].join('\n'));
  });
  return r;
}
