import type { FastifyPluginAsync } from 'fastify';
import type { RootConfig } from '../../config/index.js';

export function configRoute(cfg: RootConfig): FastifyPluginAsync {
  return async (app) => {
    app.get('/config/display', async () => cfg.display);
  };
}
