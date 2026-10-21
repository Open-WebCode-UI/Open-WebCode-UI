import { z } from 'zod';
import { userPermissions } from './auth/rbac.js';
import { getSettings } from './settings.js';
import { allowedOrigin } from './auth/session.js';
import { safeEqual } from './crypto.js';
import { scopeOf } from './courses/policy.js';

// Every route is declared through `defineRoutes` with an explicit access policy.
// access: 'public' | 'authenticated' | 'partial' (mid-login session) | '<permission>' | { perm, stepup: true }
export const registry = [];

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}
export const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

const hostOf = (o) => { try { return new URL(o).host; } catch { return null; } };

export function stepupOk(req) {
  const sec = getSettings('security');
  return Math.floor(Date.now() / 1000) - (req.session?.stepup_at || 0) <= sec.stepupWindowSec;
}

// The project a request is about: the :id of /api/projects/:id/..., or a projectId in the body or query (terminal, kernel, agent).
function projectOf(req, routePath) {
  if (/^\/api\/projects\/:id(\/|$)/.test(routePath)) return Number.isInteger(Number(req.params.id)) ? Number(req.params.id) : null;
  const v = req.body?.projectId ?? req.query?.projectId;
  return v === undefined || v === null || v === '' || !Number.isInteger(Number(v)) ? null : Number(v);
}

function guard(access, opts, routePath = '') {
  return (req, res, next) => {
    // Origin check on every state-changing request (login CSRF defense).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !opts.csrfExempt) {
      const origin = req.headers.origin;
      // Same-origin requests only: the Origin must match the configured BASE_URL or the host the request was addressed to
      // (so 127.0.0.1 vs localhost and the Vite dev proxy work), while a foreign site's Origin never matches.
      if (origin && origin !== allowedOrigin() && hostOf(origin) !== req.headers.host) return res.status(403).json({ error: 'bad_origin' });
      if (req.session) {
        const tok = req.headers['x-csrf-token'];
        if (!tok || !safeEqual(tok, req.session.csrf)) return res.status(403).json({ error: 'csrf' });
      }
    }
    if (access === 'public') return next();
    if (!req.session) return res.status(401).json({ error: 'unauthenticated' });
    if (access === 'partial') return next();
    if (req.session.stage !== 'full') return res.status(401).json({ error: 'mfa_incomplete', stage: req.session.stage });
    if (req.user.must_change_password && !opts.allowPasswordChange) return res.status(403).json({ error: 'password_change_required' });
    if (access === 'authenticated') return next();
    const perm = typeof access === 'string' ? access : access.perm;
    req.permissions = userPermissions(req.user.id);
    if (!req.permissions.has(perm)) return res.status(403).json({ error: 'forbidden', permission: perm });
    // A course exercise workspace may carry rules that take permissions away for that project only (see courses/policy.js).
    const pid = projectOf(req, routePath);
    const scope = pid === null ? null : scopeOf(pid);
    if (scope?.denied.has(perm)) return res.status(403).json({ error: 'exercise_policy', permission: perm, reason: scope.submitted ? 'submitted' : scope.expired ? 'time_limit' : 'rules' });
    if (typeof access === 'object' && access.stepup && !stepupOk(req)) {
      return res.status(403).json({ error: 'mfa_required', stepup: true, method: req.user.source === 'local' ? 'local' : 'saml' });
    }
    next();
  };
}

export function defineRoutes(router, prefix = '') {
  const def = (method) => (path, access, ...args) => {
    let opts = {};
    if (args[0] && typeof args[0] === 'object' && typeof args[0] !== 'function') opts = args.shift();
    registry.push({ method: method.toUpperCase(), path: prefix + path, access });
    router[method](prefix + path, guard(access, opts, prefix + path), ...args);
  };
  return { get: def('get'), post: def('post'), put: def('put'), delete: def('delete') };
}

export const validate = (schema, data) => {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, 'validation_error', { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  return r.data;
};
export { z };

export function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err?.name === 'ZodError') return res.status(400).json({ error: 'validation_error', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
}
