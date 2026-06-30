import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { logger } from '../telemetry/logger.js';

export function errorHandler(error: FastifyError, _req: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof ZodError) {
    reply.status(400).send({
      error: { code: 'BAD_REQUEST', message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
    });
    return;
  }

  if ((error as Error).message === 'ENGINE_NOT_READY') {
    reply.status(503).send({ error: { code: 'UNAVAILABLE', message: 'Server is loading sources, please retry shortly' } });
    return;
  }

  const status = error.statusCode ?? 500;
  if (status >= 500) logger.error(error, 'Internal server error');

  reply.status(status).send({
    error: { code: error.code ?? 'INTERNAL_ERROR', message: status < 500 ? error.message : 'Internal server error' },
  });
}
