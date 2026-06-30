import { createHash } from 'crypto';
import { mkdir, readFile, writeFile, stat, readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { logger } from '../telemetry/logger.js';

function defaultCacheDir(): string {
  return join(homedir(), '.cache', 'picogallery', 'images');
}

export class DiskImageCache {
  private dir: string;
  private maxBytes: number;
  private keys: string[] = [];

  constructor(dir: string | undefined, maxMb: number) {
    this.dir = dir ?? defaultCacheDir();
    this.maxBytes = maxMb * 1024 * 1024;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const entries = await readdir(this.dir);
      this.keys = entries.filter((e) => e.endsWith('.img'));
    } catch {
      // Fresh/unreadable cache dir — start with an empty key set.
    }
  }

  cacheKey(contentHash: string, w: number, h: number, fit: string, fmt: string): string {
    return createHash('sha256').update(`${contentHash}:${w}:${h}:${fit}:${fmt}`).digest('hex');
  }

  async has(key: string): Promise<boolean> {
    return existsSync(join(this.dir, `${key}.img`));
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
    // Re-writing an existing key (e.g. after eviction) must not add a duplicate
    // entry, or evictIfNeeded would stat + count the same file twice.
    if (!this.keys.includes(file)) this.keys.push(file);
    await this.evictIfNeeded();
  }

  private async evictIfNeeded(): Promise<void> {
    let total = 0;
    const stats = await Promise.all(
      this.keys.map(async (k) => {
        try {
          const s = await stat(join(this.dir, k));
          return { key: k, size: s.size, mtime: s.mtimeMs };
        } catch {
          return null;
        }
      })
    );
    const valid = stats.filter((x): x is { key: string; size: number; mtime: number } => x !== null);
    valid.sort((a, b) => a.mtime - b.mtime);
    for (const entry of valid) total += entry.size;
    for (const entry of valid) {
      if (total <= this.maxBytes) break;
      try {
        await unlink(join(this.dir, entry.key));
        total -= entry.size;
        this.keys = this.keys.filter((k) => k !== entry.key);
        logger.debug({ key: entry.key }, 'Evicted cache entry');
      } catch {
        // Entry already gone or unlink failed — skip and keep evicting.
      }
    }
  }
}
