import type { PhotoMeta } from '@pico/shared';
import type { PhotoSource } from '../sources/source.js';
import type { DisplayConfig } from '@pico/shared';
import { orderPhotos } from './ordering.js';
import { logger } from '../telemetry/logger.js';

// Page size per source request. PhotoPrism caps a single search response, so one
// big request silently truncates the library (an 11k-photo library returned only
// the first 10k); paging in bounded chunks gets everything with bounded memory.
export const PLAYLIST_PAGE_SIZE = 2500;
// Safety ceiling per source: 50k PhotoMeta ≈ 15 MB — the most a 512 MB Pi should
// be asked to hold. Beyond this the frame still works, just on the newest slice.
const MAX_PHOTOS_PER_SOURCE = 50_000;

export interface PlaylistBuildOptions {
  /** Anchor the cursor here after the build (resume across restarts). */
  resumePhotoId?: string;
  /** Mixed into the shuffle seed — see orderPhotos(). */
  seedSalt?: string;
}

export class Playlist {
  private photos: PhotoMeta[] = [];
  private index = 0;

  static async build(
    sources: Map<string, PhotoSource>,
    cfg: DisplayConfig,
    opts: PlaylistBuildOptions = {}
  ): Promise<Playlist> {
    const pl = new Playlist();
    const allPhotos: PhotoMeta[] = [];
    const seenIds = new Set<string>();
    for (const [name, source] of sources) {
      try {
        let count = 0;
        for (let offset = 0; count < MAX_PHOTOS_PER_SOURCE; offset += PLAYLIST_PAGE_SIZE) {
          const page = await source.listPhotos(PLAYLIST_PAGE_SIZE, offset);
          let added = 0;
          // Dedupe across pages: an insert/delete mid-pagination shifts offsets,
          // and a source that ignores `offset` would otherwise repeat forever.
          for (const p of page) {
            if (seenIds.has(p.id)) continue;
            seenIds.add(p.id);
            allPhotos.push(p);
            added++;
            count++;
          }
          if (page.length < PLAYLIST_PAGE_SIZE || added === 0) break;
        }
        logger.info({ source: name, count }, 'Loaded photos from source');
      } catch (err) {
        logger.error({ source: name, err }, 'Failed to load photos from source');
      }
    }
    pl.photos = orderPhotos(allPhotos, cfg.order, cfg.onThisDayBoost, opts.seedSalt);
    logger.info({ total: pl.photos.length }, 'Playlist built');
    // Resume where a previous process left off instead of always restarting at
    // index 0 — otherwise every restart replays the start of the cycle.
    if (opts.resumePhotoId) pl.goto(opts.resumePhotoId);
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

  /**
   * Like peekNext(), but skipping photos already shown this cycle — mirrors the
   * engine's no-repeat advance so the client prefetches the right image. Falls
   * back to the immediate neighbor when every photo has been seen (the engine
   * resets the cycle and lands exactly there).
   */
  peekNextUnseen(seen: ReadonlySet<string>): PhotoMeta | null {
    const len = this.photos.length;
    if (len === 0) return null;
    for (let step = 1; step <= len; step++) {
      const p = this.photos[(this.index + step) % len]!;
      if (!seen.has(p.id)) return p;
    }
    return this.peekNext();
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

  /** All photo ids, as a Set — used to prune stale ids from the seen-set. */
  idSet(): Set<string> {
    return new Set(this.photos.map((p) => p.id));
  }

  slice(offset: number, limit: number): PhotoMeta[] {
    return this.photos.slice(offset, offset + limit);
  }

  countBySource(sourceName: string): number {
    return this.photos.filter((p) => p.sourceName === sourceName).length;
  }
}
