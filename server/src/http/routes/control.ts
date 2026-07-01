import type { FastifyPluginAsync } from 'fastify';
import { ControlActionSchema } from '@pico/shared';
import { getEngine } from '../../engine/index.js';

export const controlRoute: FastifyPluginAsync = async (app) => {
  app.post('/control', async (req, reply) => {
    const action = ControlActionSchema.parse(req.body);
    const engine = getEngine();
    switch (action.action) {
      case 'next': engine.next(); break;
      case 'prev': engine.prev(); break;
      case 'toggle_pause': engine.togglePause(); break;
      case 'pause': engine.pause(); break;
      case 'resume': engine.resume(); break;
      case 'goto':
        if (action.id && !engine.goto(action.id)) {
          return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Photo not found' } });
        }
        break;
    }
    // Per API spec §8.3: control acks with { ok: true }; the resulting state is
    // broadcast to every client over the SSE `state` event, not returned here.
    return { ok: true };
  });
};
