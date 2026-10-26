import express from 'express';
import { defineRoutes, validate, z } from '../http.js';
import { getOnboarding, updateOnboarding, completeOnboarding } from '../onboarding.js';

const update = z.object({ stepIndex: z.number().int().min(0).max(99), restart: z.boolean().optional() });

export function onboardingRouter() {
  const r = express.Router();
  const route = defineRoutes(r, '/api/user/onboarding');

  // The tutorial belongs to the signed-in user only; every user has one regardless of role.
  route.get('', 'authenticated', async (req, res) => res.json(await getOnboarding(req.user.id)));
  route.post('/update', 'authenticated', async (req, res) => {
    const b = validate(update, req.body);
    res.json(await updateOnboarding(req.user.id, b.stepIndex, { restart: b.restart }));
  });
  route.post('/complete', 'authenticated', async (req, res) => res.json(await completeOnboarding(req.user.id)));
  return r;
}
