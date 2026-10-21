import express from 'express';
import { defineRoutes, validate, z, fail } from '../http.js';
import { getDb } from '../db/index.js';
import { audit } from '../audit.js';
import { userDto } from '../users.js';
import { prefSchema, readPreferences } from '../preferences.js';

const trimmed = z.string().trim().max(100);

export function profileRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/api/profile');

  // Local accounts edit their own name; single sign-on names come from the identity provider and are overwritten at each login.
  route.put('/account', 'authenticated', (req, res) => {
    if (req.user.source !== 'local') fail(403, 'managed_by_idp', { message: 'Your name is managed by your identity provider.' });
    const b = validate(z.object({ firstName: trimmed, lastName: trimmed }).strict(), req.body);
    if (!b.firstName && !b.lastName) fail(400, 'validation_error', { message: 'Enter a first or last name.' });
    const displayName = `${b.firstName} ${b.lastName}`.trim();
    const db = getDb();
    db.prepare('UPDATE users SET first_name=?, last_name=?, display_name=? WHERE id=?').run(b.firstName, b.lastName, displayName, req.user.id);
    audit(req.user.id, 'profile.account.update', null, { fields: ['firstName', 'lastName'] });
    res.json({ user: userDto(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id), { withPerms: true }) });
  });

  route.get('/preferences', 'authenticated', (req, res) => res.json(readPreferences(req.user)));

  // Partial update: only the supplied keys change.
  route.put('/preferences', 'authenticated', (req, res) => {
    const patch = validate(prefSchema.partial(), req.body);
    const next = { ...readPreferences(req.user), ...patch };
    getDb().prepare('UPDATE users SET preferences=? WHERE id=?').run(JSON.stringify(next), req.user.id);
    audit(req.user.id, 'profile.preferences.update', null, { fields: Object.keys(patch) });
    res.json(next);
  });

  return r;
}
