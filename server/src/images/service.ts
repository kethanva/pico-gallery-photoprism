import os from 'os';
import type { Readable } from 'stream';
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

    // When the source already knows a stable identity for the original
    // (PhotoPrism file hash, directory path+mtime+size, WebDAV etag), key the
    // cache off it. A repeat view is then a pure disk-cache hit: we never
    // re-fetch the original or re-read it off the SD card — the expensive part
    // on a 24/7 frame cycling every few seconds. The lookup key and the store
    // key must be the same, so we resolve identity *before* fetching and reuse
    // it for the put.
    if (meta.contentHash) {
      const key = this.cache.cacheKey(meta.contentHash, w, h, fit, resolvedFmt);
      const cached = await this.cache.get(key);
      if (cached) {
        return { data: cached, contentType: mimeFor(resolvedFmt), cacheKey: key, hit: true };
      }
      const { stream } = await source.getOriginal(meta, w, h);
      const output = await this.resize(stream, w, h, fit, resolvedFmt, meta);
      await this.cache.put(key, output);
      return { data: output, contentType: mimeFor(resolvedFmt), cacheKey: key, hit: false };
    }

    // No pre-known identity: fetch first, then key off a hash of the bytes. This
    // still pays the fetch on every view, which is why every real source sets a
    // contentHash above; this branch is the safety net for ones that can't.
    const { stream, contentHash } = await source.getOriginal(meta, w, h);
    const key = this.cache.cacheKey(contentHash, w, h, fit, resolvedFmt);
    const cached = await this.cache.get(key);
    if (cached) {
      return { data: cached, contentType: mimeFor(resolvedFmt), cacheKey: key, hit: true };
    }
    const output = await this.resize(stream, w, h, fit, resolvedFmt, meta);
    await this.cache.put(key, output);
    return { data: output, contentType: mimeFor(resolvedFmt), cacheKey: key, hit: false };
  }

  /** Buffer a source stream, guard it, HEIC-transcode if needed, then resize to fmt. */
  private async resize(
    stream: Readable,
    w: number,
    h: number,
    fit: 'cover' | 'contain',
    fmt: 'webp' | 'jpeg' | 'avif',
    meta: PhotoMeta
  ): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
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
      .toFormat(fmt, { quality: 85 })
      .toBuffer();
    logger.debug({ id: meta.id, w, h, fit, fmt, bytes: output.length }, 'Image resized');
    return output;
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
