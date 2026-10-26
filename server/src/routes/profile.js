import express from 'express';
import { defineRoutes, validate, z, fail } from '../http.js';
import { getKnex } from '../db/index.js';
import { audit } from '../audit.js';
import { userDto } from '../users.js';
import { prefSchema, readPreferences } from '../preferences.js';

const trimmed = z.string().trim().max(100);

export function profileRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/api/profile');

  // Local accounts edit their own name; single sign-on names come from the identity provider and are overwritten at each login.
  route.put('/account', 'authenticated', async (req, res) => {
    if (req.user.source !== 'local') fail(403, 'managed_by_idp', { message: 'Your name is managed by your identity provider.' });
    const b = validate(z.object({ firstName: trimmed, lastName: trimmed }).strict(), req.body);
    if (!b.firstName && !b.lastName) fail(400, 'validation_error', { message: 'Enter a first or last name.' });
    const displayName = `${b.firstName} ${b.lastName}`.trim();
    const k = getKnex();
    await k('users').where({ id: req.user.id }).update({ first_name: b.firstName, last_name: b.lastName, display_name: displayName });
    audit(req.user.id, 'profile.account.update', null, { fields: ['firstName', 'lastName'] });
    res.json({ user: userDto(await k('users').where({ id: req.user.id }).first(), { withPerms: true }) });
  });

  route.get('/preferences', 'authenticated', (req, res) => res.json(readPreferences(req.user)));

  // Partial update: only the supplied keys change.
  route.put('/preferences', 'authenticated', async (req, res) => {
    const patch = validate(prefSchema.partial(), req.body);
    const next = { ...readPreferences(req.user), ...patch };
    await getKnex()('users').where({ id: req.user.id }).update({ preferences: JSON.stringify(next) });
    audit(req.user.id, 'profile.preferences.update', null, { fields: Object.keys(patch) });
    res.json(next);
  });

  return r;
}
