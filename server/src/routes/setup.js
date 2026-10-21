import express from 'express';
import { getDb } from '../db/index.js';
import { defineRoutes, validate, z } from '../http.js';
import { getSettings, saveSettings } from '../settings.js';
import { audit } from '../audit.js';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
// Only low-risk choices are offered here. Shell execution, MFA, SSO and HTTPS have their own pages (several need step-up).
const choices = z.object({
  appName: z.string().trim().min(1).max(80),
  tagline: z.string().max(200),
  primaryColor: hex.optional(),
  defaultMode: z.enum(['system', 'light', 'dark']).optional(),
  memoryAllowed: z.boolean(),
  coursesEnabled: z.boolean(),
  userMcpAllowed: z.boolean(),
  showSessionCost: z.boolean(),
});
const body = z.union([z.object({ skip: z.literal(true) }), z.object({ skip: z.literal(false).optional(), choices })]);

const state = () => {
  const g = getSettings('general'), b = getSettings('branding');
  return {
    completed: getSettings('setup').completed,
    values: { appName: g.appName, tagline: g.tagline, primaryColor: b.primaryColor, defaultMode: b.defaultMode,
      memoryAllowed: g.memoryAllowed, coursesEnabled: g.coursesEnabled, userMcpAllowed: g.userMcpAllowed, showSessionCost: g.showSessionCost },
    modelCount: getDb().prepare('SELECT COUNT(*) n FROM models').get().n,
    execMode: g.execMode,
  };
};

export function setupRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/api/admin/setup');

  route.get('', 'settings.write', (_req, res) => res.json(state()));
  route.post('/complete', 'settings.write', (req, res) => {
    const b = validate(body, req.body);
    if (getSettings('setup').completed) return res.json(state()); // a second administrator's late submit must not overwrite the first's choices
    if (b.choices) {
      const c = b.choices;
      saveSettings('general', { ...getSettings('general'), appName: c.appName, tagline: c.tagline, memoryAllowed: c.memoryAllowed,
        coursesEnabled: c.coursesEnabled, userMcpAllowed: c.userMcpAllowed, showSessionCost: c.showSessionCost });
      if (req.permissions.has('branding.write')) {
        const br = getSettings('branding');
        saveSettings('branding', { ...br, primaryColor: c.primaryColor ?? br.primaryColor, defaultMode: c.defaultMode ?? br.defaultMode });
      }
    }
    saveSettings('setup', { completed: true, skipped: !!b.skip, completedBy: req.user.id });
    audit(req.user.id, b.skip ? 'setup.skip' : 'setup.complete', null, b.choices ? { ...b.choices } : {});
    res.json(state());
  });
  return r;
}
