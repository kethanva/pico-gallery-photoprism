import type { FastifyPluginAsync } from 'fastify';
import { getEngine } from '../../engine/index.js';

export const sourcesRoute: FastifyPluginAsync = async (app) => {
  app.get('/sources', async () => {
    const engine = getEngine();
    const sources = engine.getSources();
    const playlist = engine.getPlaylist();

    return Promise.all(
      [...sources.values()].map(async (src) => {
        const auth = await src.authStatus().catch(() => ({ kind: 'unauthenticated' as const }));
        const authLabel =
          auth.kind === 'authenticated' ? 'authenticated'
          : auth.kind === 'pending' ? 'pending'
          : 'unauthenticated';
        return {
          name: src.name,
          displayName: src.displayName,
          auth: authLabel,
          photoCount: playlist.countBySource(src.name),
        };
      })
    );
  });

  app.post<{ Params: { name: string } }>('/sources/:name/auth', async (req, reply) => {
    const engine = getEngine();
    const source = engine.getSources().get(req.params.name);
    if (!source) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Source not found' } });
    }
    const result = await source.authenticate();
    const status =
      result.kind === 'authenticated' ? 'authenticated'
      : result.kind === 'pending' ? 'pending'
      : 'unauthenticated';
    const response: Record<string, unknown> = { status };
    if (result.kind === 'pending') {
      response['message'] = result.message;
      response['pollSecs'] = result.pollSecs;
    } else if (result.kind === 'unauthenticated' && result.error) {
      response['error'] = result.error;
    }
    return response;
  });
};
