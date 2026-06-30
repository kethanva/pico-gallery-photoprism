import type { FastifyPluginAsync } from 'fastify';
import { getEngine } from '../../engine/index.js';
import { sseHandler } from '../sse.js';

export const slideshowRoute: FastifyPluginAsync = async (app) => {
  app.get('/slideshow/state', async () => getEngine().getState());
  // SSE stream lives at the top level per API spec §8.2 (GET /api/v1/events).
  app.get('/events', sseHandler);
};
