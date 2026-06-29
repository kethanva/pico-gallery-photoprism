import type { FastifyPluginAsync } from 'fastify';
import { getEngine } from '../../engine/index.js';

export const healthRoute: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  app.get('/ready', async (_req, reply) => {
    try {
      const engine = getEngine();
      const state = engine.getState();
      if (state.total === 0) {
        return reply.status(503).send({ status: 'starting', message: 'Playlist is empty' });
      }
      return { status: 'ready', total: state.total };
    } catch {
      return reply.status(503).send({ status: 'starting', message: 'Engine not ready' });
    }
  });
};
