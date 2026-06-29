import { readdir, stat, readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { join, extname, basename, dirname, relative } from 'path';
import { homedir } from 'os';
import { Readable } from 'stream';
import exifr from 'exifr';
import type { PhotoMeta, AuthStatus } from '@pico/shared';
import type { PhotoSource, GetOriginalResult } from './source.js';
import type { DirectoryConfig } from '../config/index.js';
import { logger } from '../telemetry/logger.js';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.tif', '.heic', '.avif']);

/**
 * Read the real capture date + pixel dimensions from EXIF (exifr reads only the
 * metadata bytes, not the whole image, so this stays cheap at scan time). Returns
 * an empty object for formats without EXIF; the caller falls back to file mtime.
 */
async function readExif(filePath: string): Promise<{ takenAt?: string; width?: number; height?: number }> {
  try {
    const x = (await exifr.parse(filePath, { tiff: true, exif: true, ifd0: true })) as
      | Record<string, unknown>
      | undefined;
    if (!x) return {};
    const date = (x['DateTimeOriginal'] ?? x['CreateDate'] ?? x['ModifyDate']) as Date | undefined;
    const takenAt = date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
    const width = (x['ExifImageWidth'] ?? x['ImageWidth']) as number | undefined;
    const height = (x['ExifImageHeight'] ?? x['ImageHeight']) as number | undefined;
    return { takenAt, width, height };
  } catch {
    return {};
  }
}

function resolvePath(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

async function* walkDir(dir: string, recursive: boolean): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && recursive) {
      yield* walkDir(full, recursive);
    } else if (entry.isFile() && IMAGE_EXTS.has(extname(entry.name).toLowerCase())) {
      yield full;
    }
  }
}

export class DirectorySource implements PhotoSource {
  readonly name = 'directory';
  readonly displayName = 'Directory';
  private cfg!: DirectoryConfig;
  private photos: PhotoMeta[] = [];
  private rescanTimer?: ReturnType<typeof setInterval>;

  async init(cfg: unknown): Promise<void> {
    this.cfg = cfg as DirectoryConfig;
    await this.scan();
    this.rescanTimer = setInterval(
      () => this.scan().catch((e: unknown) => logger.error(e, 'Directory rescan failed')),
      (this.cfg.rescanIntervalSecs ?? 3600) * 1000
    );
  }

  async authStatus(): Promise<AuthStatus> {
    return { kind: 'authenticated' };
  }

  async authenticate(): Promise<AuthStatus> {
    return { kind: 'authenticated' };
  }

  async listPhotos(limit: number, offset: number): Promise<PhotoMeta[]> {
    return this.photos.slice(offset, offset + limit);
  }

  async getOriginal(meta: PhotoMeta, _w: number, _h: number): Promise<GetOriginalResult> {
    const filePath = meta.id.slice(this.name.length + 1);
    const bytes = await readFile(filePath);
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const stream = Readable.from([bytes]);
    const ext = extname(filePath).toLowerCase();
    const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { stream, contentType, contentHash };
  }

  async dispose(): Promise<void> {
    if (this.rescanTimer) clearInterval(this.rescanTimer);
  }

  private async scan(): Promise<void> {
    const photos: PhotoMeta[] = [];
    const roots = this.cfg.paths.map(resolvePath);
    for (const root of roots) {
      for await (const filePath of walkDir(root, this.cfg.recursive ?? true)) {
        const album = relative(root, dirname(filePath)) || basename(root);
        if (this.cfg.allowedAlbums && !this.cfg.allowedAlbums.includes(album)) continue;
        // Prefer the EXIF capture date (so ordering/on-this-day are accurate); fall
        // back to the file mtime when there is no EXIF date.
        const exif = await readExif(filePath);
        let takenAt = exif.takenAt;
        if (!takenAt) {
          try {
            takenAt = (await stat(filePath)).mtime.toISOString();
          } catch {}
        }
        photos.push({
          id: `directory:${filePath}`,
          sourceName: 'directory',
          filename: basename(filePath),
          album: album || undefined,
          takenAt,
          width: exif.width ?? 0,
          height: exif.height ?? 0,
          favorite: false,
        });
      }
    }
    this.photos = photos;
    logger.info({ count: photos.length }, 'Directory scan complete');
  }
}
