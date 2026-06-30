import os from 'os';
import sharp from 'sharp';
import type { PhotoMeta } from '@pico/shared';
import type { PhotoSource } from '../sources/source.js';
import { DiskImageCache } from './cache.js';
import { checkGuard, checkPixels, ImageGuardError } from './guard.js';
import { isHeic, heicToJpeg } from './heic.js';
import { logger } from '../telemetry/logger.js';

export { ImageGuardError };

const LOW_MEM_BYTES = 1.5 * 1024 * 1024 * 1024;

/**
 * Tune libvips for the host. On a 512 MB board (Pi Zero 2 W) the resize worker
 * shares RAM with the WebKit kiosk, so cap libvips to a single thread and a
 * small operation cache — the default (one thread per core + a large cache)
 * spikes memory and can OOM the frame. Call once at startup.
 */
export function tuneSharpForHost(): void {
  const lowMem = os.totalmem() < LOW_MEM_BYTES;
  sharp.concurrency(lowMem ? 1 : 0); // 0 = libvips default (#cores)
  sharp.cache(lowMem ? { memory: 48, files: 0, items: 64 } : true);
  logger.info({ lowMem, concurrency: sharp.concurrency() }, 'sharp tuned for host');
}

export class ImageService {
  constructor(
    private readonly cache: DiskImageCache,
    private readonly maxMb: number,
    private readonly maxMegapixels: number
  ) {}

  async getImage(
    source: PhotoSource,
    meta: PhotoMeta,
    w: number,
    h: number,
    fit: 'cover' | 'contain',
    fmt: 'auto' | 'webp' | 'jpeg' | 'avif',
    acceptHeader: string
  ): Promise<{ data: Buffer; contentType: string; cacheKey: string; hit: boolean }> {
    const resolvedFmt = fmt === 'auto' ? negotiateFormat(acceptHeader) : fmt;

    // Fast path: if PhotoMeta already carries a contentHash (PhotoPrism, WebDAV), check cache first.
    if (meta.contentHash) {
      const earlyKey = this.cache.cacheKey(meta.contentHash, w, h, fit, resolvedFmt);
      const cached = await this.cache.get(earlyKey);
      if (cached) {
        return { data: cached, contentType: mimeFor(resolvedFmt), cacheKey: earlyKey, hit: true };
      }
    }

    const { stream: srcStream, contentHash } = await source.getOriginal(meta, w, h);

    // After fetching (which computes/confirms the real content hash), check again before resizing.
    const finalKey = this.cache.cacheKey(contentHash, w, h, fit, resolvedFmt);
    const cachedFinal = await this.cache.get(finalKey);
    if (cachedFinal) {
      return { data: cachedFinal, contentType: mimeFor(resolvedFmt), cacheKey: finalKey, hit: true };
    }

    const chunks: Buffer[] = [];
    for await (const chunk of srcStream) chunks.push(chunk as Buffer);
    let input: Buffer = Buffer.concat(chunks);

    checkGuard(input, this.maxMb, this.maxMegapixels);

    // sharp's prebuilt libvips can't decode HEIC; transcode to JPEG first.
    if (isHeic(input)) {
      input = await heicToJpeg(input);
    }

    const pipeline = sharp(input).rotate();
    const metadata = await pipeline.metadata();
    if (metadata.width && metadata.height) checkPixels(metadata.width, metadata.height, this.maxMegapixels);

    const fitMode = fit === 'cover' ? ('cover' as const) : ('inside' as const);
    const output = await pipeline
      .resize(w, h, { fit: fitMode, withoutEnlargement: true })
      .toFormat(resolvedFmt, { quality: 85 })
      .toBuffer();

    await this.cache.put(finalKey, output);
    logger.debug({ id: meta.id, w, h, fit, fmt: resolvedFmt, bytes: output.length }, 'Image resized');
    return { data: output, contentType: mimeFor(resolvedFmt), cacheKey: finalKey, hit: false };
  }
}

// `auto` never picks AVIF: AVIF *encode* is far costlier than WebP and would add
// seconds per first-view image on a Pi-class CPU. AVIF stays opt-in via fmt=avif.
function negotiateFormat(accept: string): 'webp' | 'jpeg' {
  if (accept.includes('image/webp')) return 'webp';
  return 'jpeg';
}

function mimeFor(fmt: string): string {
  if (fmt === 'avif') return 'image/avif';
  if (fmt === 'webp') return 'image/webp';
  return 'image/jpeg';
}
