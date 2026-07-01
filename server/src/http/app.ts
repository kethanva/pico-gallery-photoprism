import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import type { RootConfig } from '../config/index.js';
import { errorHandler } from './errors.js';
import { healthRoute } from './routes/health.js';
import { slideshowRoute } from './routes/slideshow.js';
import { controlRoute } from './routes/control.js';
import { photosRoute } from './routes/photos.js';
import { configRoute } from './routes/config.js';
import { sourcesRoute } from './routes/sources.js';
import { logger } from '../telemetry/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function buildApp(cfg: RootConfig) {
  const app = Fastify({ logger: false, trustProxy: true });

  await app.register(helmet, {
    contentSecurityPolicy: false, // Allow SSE and inline scripts
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // Match the API error envelope (§8.6) instead of fastify-rate-limit's default.
    errorResponseBuilder: (_req, context) => ({
      error: { code: 'RATE_LIMITED', message: `Rate limit exceeded, retry in ${context.after}` },
    }),
  });

  // Serve client SPA from dist if it exists
  const clientDist = join(__dirname, '..', '..', '..', 'client', 'dist');
  if (existsSync(clientDist)) {
    await app.register(staticFiles, {
      root: clientDist,
      prefix: '/',
      decorateReply: true,
    });
  } else {
    logger.warn({ path: clientDist }, 'Client dist not found; static serving disabled');
  }

  app.setErrorHandler(errorHandler);

  // Auth middleware if token configured. Health/readiness probes stay public so
  // the kiosk launcher (and load balancers) can poll them without the token.
  const token = cfg.http.authToken;
  if (token) {
    const publicPaths = new Set(['/api/v1/health', '/api/v1/ready']);
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/')) return;
      const path = req.url.split('?')[0];
      if (publicPaths.has(path)) return;

      // Local kiosk running on localhost bypasses token auth
      if (req.ip === '127.0.0.1' || req.ip === '::1') return;

      // Support Bearer token header or query string token (fallback for EventSource/images)
      const authHeader = req.headers.authorization;
      const queryToken = (req.query as Record<string, string> | undefined)?.token;
      const providedToken = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : queryToken;

      if (!providedToken || providedToken !== token) {
        // Returning the reply halts the lifecycle; without it Fastify still runs
        // the route handler and then throws FST_ERR_REP_ALREADY_SENT.
        return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
      }
    });
  }

  await app.register(
    async (api) => {
      await api.register(healthRoute);
      await api.register(slideshowRoute);
      await api.register(controlRoute);
      await api.register(photosRoute(cfg));
      await api.register(configRoute(cfg));
      await api.register(sourcesRoute);
    },
    { prefix: '/api/v1' }
  );

  return app;
}
