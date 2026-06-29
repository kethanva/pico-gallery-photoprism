import type { FastifyPluginAsync } from 'fastify';
import { getEngine } from '../../engine/index.js';
import { sseHandler } from '../sse.js';

export const slideshowRoute: FastifyPluginAsync = async (app) => {
  app.get('/slideshow/state', async () => getEngine().getState());
  app.get('/slideshow/events', sseHandler);
};
