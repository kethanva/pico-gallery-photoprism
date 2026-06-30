import type { FastifyPluginAsync } from 'fastify';
import { PhotosQuerySchema, ImageQuerySchema } from '@pico/shared';
import { getEngine } from '../../engine/index.js';
import { ImageService, ImageGuardError } from '../../images/service.js';
import { DiskImageCache } from '../../images/cache.js';
import type { RootConfig } from '../../config/index.js';

export function photosRoute(cfg: RootConfig): FastifyPluginAsync {
  return async (app) => {
    const cache = new DiskImageCache(cfg.cache.dir, cfg.cache.maxMb);
    await cache.init();
    const imageService = new ImageService(cache, cfg.display.maxImageMb, cfg.display.maxMegapixels);

    app.get('/photos', async (req) => {
      const q = PhotosQuerySchema.parse(req.query);
      const engine = getEngine();
      const playlist = engine.getPlaylist();
      const items = playlist.slice(q.offset, q.limit);
      return { items, total: playlist.length, offset: q.offset, limit: q.limit };
    });

    app.get<{ Params: { id: string } }>('/photos/:id/meta', async (req, reply) => {
      const engine = getEngine();
      const photo = engine.getPlaylist().findById(decodeURIComponent(req.params.id));
      if (!photo) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Photo not found' } });
      return photo;
    });

    app.get<{ Params: { id: string } }>('/photos/:id/image', async (req, reply) => {
      const q = ImageQuerySchema.parse(req.query);
      const engine = getEngine();
      const photo = engine.getPlaylist().findById(decodeURIComponent(req.params.id));
      if (!photo) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Photo not found' } });

      const source = engine.getSources().get(photo.sourceName);
      if (!source) return reply.status(503).send({ error: { code: 'UNAVAILABLE', message: 'Source not available' } });

      const accept = req.headers.accept ?? '';
      try {
        const { data, contentType, cacheKey, hit } = await imageService.getImage(source, photo, q.w, q.h, q.fit, q.fmt, accept);
        const etag = `"${cacheKey}"`;
        if (req.headers['if-none-match'] === etag) return reply.status(304).send();
        return reply
          .header('Content-Type', contentType)
          .header('ETag', etag)
          .header('Cache-Control', 'public, max-age=31536000, immutable')
          .header('X-Cache', hit ? 'HIT' : 'MISS')
          .send(data);
      } catch (err) {
        if (err instanceof ImageGuardError) {
          return reply.status(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: (err as Error).message } });
        }
        return reply.status(502).send({ error: { code: 'SOURCE_ERROR', message: 'Failed to fetch or decode image from source' } });
      }
    });
  };
}
