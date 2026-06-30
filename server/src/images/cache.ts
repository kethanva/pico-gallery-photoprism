import { createHash } from 'crypto';
import { mkdir, readFile, writeFile, stat, readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../telemetry/logger.js';

function defaultCacheDir(): string {
  return join(homedir(), '.cache', 'picogallery', 'images');
}

interface Entry {
  size: number;
  mtime: number;
}

/**
 * Content-addressed disk cache for resized images. Sizes + write times are held
 * in memory and a running total is maintained, so a `put` is O(1) and eviction
 * only runs (and only sorts) when the budget is exceeded — no per-write `stat`
 * of the whole directory, which would be an I/O storm on a Pi's SD card once the
 * cache holds thousands of entries.
 */
export class DiskImageCache {
  private dir: string;
  private maxBytes: number;
  private entries = new Map<string, Entry>();
  private totalBytes = 0;

  constructor(dir: string | undefined, maxMb: number) {
    this.dir = dir ?? defaultCacheDir();
    this.maxBytes = maxMb * 1024 * 1024;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const files = (await readdir(this.dir)).filter((e) => e.endsWith('.img'));
      // One stat pass at startup to seed sizes; cheap and bounded to boot.
      const seen = await Promise.all(
        files.map(async (f) => {
          try {
            const s = await stat(join(this.dir, f));
            return [f, { size: s.size, mtime: s.mtimeMs }] as const;
          } catch {
            return null;
          }
        })
      );
      for (const e of seen) {
        if (!e) continue;
        this.entries.set(e[0], e[1]);
        this.totalBytes += e[1].size;
      }
    } catch {
      // Fresh/unreadable cache dir — start empty.
    }
  }

  cacheKey(contentHash: string, w: number, h: number, fit: string, fmt: string): string {
    return createHash('sha256').update(`${contentHash}:${w}:${h}:${fit}:${fmt}`).digest('hex');
  }

  async has(key: string): Promise<boolean> {
    return this.entries.has(`${key}.img`);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(join(this.dir, `${key}.img`));
    } catch {
      return null;
    }
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = `${key}.img`;
    await writeFile(join(this.dir, file), data, { mode: 0o600 });
    const prev = this.entries.get(file);
    if (prev) this.totalBytes -= prev.size; // overwrite: drop the old size first
    this.entries.set(file, { size: data.length, mtime: Date.now() });
    this.totalBytes += data.length;
    await this.evictIfNeeded();
  }

  /** Evict oldest-written entries until under budget. No-op (and no sort) when within budget. */
  private async evictIfNeeded(): Promise<void> {
    if (this.totalBytes <= this.maxBytes) return;
    const oldestFirst = [...this.entries.entries()].sort((a, b) => a[1].mtime - b[1].mtime);
    for (const [file, meta] of oldestFirst) {
      if (this.totalBytes <= this.maxBytes) break;
      try {
        await unlink(join(this.dir, file));
      } catch {
        // Already gone — fall through and drop our accounting for it anyway.
      }
      this.entries.delete(file);
      this.totalBytes -= meta.size;
      logger.debug({ key: file }, 'Evicted cache entry');
    }
  }
}
