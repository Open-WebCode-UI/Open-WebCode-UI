import express from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, cookieSecure } from './config.js';
import { sessionMiddleware } from './auth/session.js';
import { errorHandler, registry } from './http.js';
import { authRouter } from './routes/auth.js';
import { samlRouter } from './auth/saml.js';
import { adminRouter } from './routes/admin.js';
import { apiKeysRouter } from './routes/apikeys.js';
import { apiDocsRouter } from './routes/apidocs.js';
import { v1Router } from './routes/v1.js';
import { providersRouter } from './routes/providers.js';
import { badgesRouter } from './routes/badges.js';
import { projectsRouter } from './routes/projects.js';
import { agentRouter } from './routes/agent.js';
import { skillsRouter } from './routes/skills.js';
import { terminalRouter } from './routes/terminal.js';
import { kernelRouter } from './routes/kernel.js';
import { sessionsRouter } from './routes/sessions.js';
import { reportsRouter } from './routes/reports.js';
import { onboardingRouter } from './routes/onboarding.js';
import { setupRouter } from './routes/setup.js';
import { mcpRouter } from './routes/mcp.js';
import { memoryRouter } from './routes/memory.js';
import { webSearchRouter } from './routes/websearch.js';
import { profileRouter } from './routes/profile.js';
import { attachmentsRouter } from './routes/attachments.js';
import { coursesRouter } from './routes/courses.js';
import { coursesEnabled } from './settings.js';
import { assessmentsRouter } from './routes/assessments.js';
import { getDb } from './db/index.js';
import { createLocalUser } from './users.js';
import { randomToken } from './crypto.js';
import { audit } from './audit.js';
import { isLocalHost } from './tls.js';

export function bootstrap() {
  const db = getDb();
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return null;
  const password = config.breakGlassPassword || randomToken(15);
  createLocalUser({ username: 'breakglass', password, roles: ['administrator'], isBreakGlass: true, mustChange: !config.breakGlassPassword });
  audit(null, 'bootstrap.breakglass_created', 'breakglass');
  return config.breakGlassPassword ? null : password;
}

export function createApp({ deps = {} } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
  if (config.isProd && !cookieSecure() && !config.allowInsecureDev && !config.plainHttp) throw new Error('BASE_URL must be https:// in production (or set ALLOW_INSECURE_DEV=1)');

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'], imgSrc: ["'self'", 'data:'], mediaSrc: ["'self'"], connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'], frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
        // Only ask browsers to upgrade to https when we actually serve https (otherwise assets would fail to load over http).
        upgradeInsecureRequests: cookieSecure() ? [] : null,
      },
    },
    // HSTS is per host name (not per port): never pin "localhost", it would break every other local http server.
    hsts: cookieSecure() && !isLocalHost(new URL(config.baseUrl).hostname) ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'same-origin' }, crossOriginOpenerPolicy: { policy: 'same-origin' },
  }));
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // The provider API authenticates with API keys (never cookies) and parses its own, larger bodies, so it sits ahead of both.
  app.use('/v1', v1Router({ adapterFactory: deps.adapterFactory }));
  // The zip import route parses its own (much larger, admin-configurable) body; the global 1mb parser would reject it first.
  const json1mb = express.json({ limit: '1mb' });
  app.use((req, res, next) => (req.path === '/api/projects/import' ? next() : json1mb(req, res, next)));
  app.use(sessionMiddleware);

  app.use(authRouter());
  app.use(samlRouter());
  app.use(adminRouter({ webSearch: deps.webSearch }));
  app.use(apiKeysRouter());
  app.use(apiDocsRouter());
  app.use(providersRouter({ adapterFactory: deps.adapterFactory, lookup: deps.lookup }));
  app.use(badgesRouter());
  app.use(projectsRouter());
  app.use(agentRouter({ adapterFactory: deps.adapterFactory, deps }));
  app.use(skillsRouter());
  app.use(mcpRouter({ deps: deps.mcp }));
  app.use(memoryRouter());
  app.use(webSearchRouter({ deps: deps.webSearch }));
  app.use(profileRouter());
  app.use(attachmentsRouter());
  // Routes that only check that you are signed in (not a permission) still need to refuse when Courses is off.
  app.use(['/api/courses', '/api/admin/course-settings'], (_req, res, next) => (coursesEnabled() ? next() : res.status(404).json({ error: 'courses_disabled' })));
  app.use(coursesRouter({ adapterFactory: deps.adapterFactory }));
  app.use(assessmentsRouter());
  app.use(terminalRouter({ manager: deps.terminals }));
  app.use(kernelRouter({ manager: deps.kernels }));
  app.use(sessionsRouter());
  app.use(reportsRouter());
  app.use(onboardingRouter());
  app.use(setupRouter());
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, setHeaders: (res) => res.set('Cache-Control', 'public, max-age=300') }));
    app.get('/{*splat}', (_req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(dist, 'index.html')));
  }
  app.use(errorHandler);
  return app;
}
export { registry };
