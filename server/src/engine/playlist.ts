import type { PhotoMeta } from '@pico/shared';
import type { PhotoSource } from '../sources/source.js';
import type { DisplayConfig } from '@pico/shared';
import { orderPhotos } from './ordering.js';
import { logger } from '../telemetry/logger.js';

export class Playlist {
  private photos: PhotoMeta[] = [];
  private index = 0;

  static async build(sources: Map<string, PhotoSource>, cfg: DisplayConfig): Promise<Playlist> {
    const pl = new Playlist();
    const allPhotos: PhotoMeta[] = [];
    for (const [name, source] of sources) {
      try {
        const photos = await source.listPhotos(10000, 0);
        allPhotos.push(...photos);
        logger.info({ source: name, count: photos.length }, 'Loaded photos from source');
      } catch (err) {
        logger.error({ source: name, err }, 'Failed to load photos from source');
      }
    }
    pl.photos = orderPhotos(allPhotos, cfg.order, cfg.onThisDayBoost);
    logger.info({ total: pl.photos.length }, 'Playlist built');
    return pl;
  }

  get length(): number {
    return this.photos.length;
  }

  get currentIndex(): number {
    return this.index;
  }

  current(): PhotoMeta | null {
    return this.photos[this.index] ?? null;
  }

  /** The photo that `next()` would land on — used to prefetch ahead of the swap. */
  peekNext(): PhotoMeta | null {
    if (this.photos.length === 0) return null;
    return this.photos[(this.index + 1) % this.photos.length] ?? null;
  }

  next(): PhotoMeta | null {
    if (this.photos.length === 0) return null;
    this.index = (this.index + 1) % this.photos.length;
    return this.current();
  }

  prev(): PhotoMeta | null {
    if (this.photos.length === 0) return null;
    this.index = (this.index - 1 + this.photos.length) % this.photos.length;
    return this.current();
  }

  goto(id: string): PhotoMeta | null {
    const idx = this.photos.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    this.index = idx;
    return this.current();
  }

  findById(id: string): PhotoMeta | undefined {
    return this.photos.find((p) => p.id === id);
  }

  slice(offset: number, limit: number): PhotoMeta[] {
    return this.photos.slice(offset, offset + limit);
  }

  countBySource(sourceName: string): number {
    return this.photos.filter((p) => p.sourceName === sourceName).length;
  }
}
