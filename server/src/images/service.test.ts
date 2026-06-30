import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import sharp from 'sharp';
import type { PhotoMeta, AuthStatus } from '@pico/shared';
import type { PhotoSource, GetOriginalResult } from '../sources/source.js';
import { DiskImageCache } from './cache.js';
import { ImageService } from './service.js';

async function tinyPng(): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 20, b: 30 } } })
    .png()
    .toBuffer();
}

// Counts how many times the original is actually fetched, so we can assert that
// a cache hit does NOT touch the source.
class CountingSource implements PhotoSource {
  readonly name = 'fake';
  readonly displayName = 'Fake';
  fetches = 0;
  constructor(
    private readonly bytes: Buffer,
    private readonly hash: string
  ) {}
  async init(): Promise<void> {}
  async authStatus(): Promise<AuthStatus> {
    return { kind: 'authenticated' };
  }
  async authenticate(): Promise<AuthStatus> {
    return { kind: 'authenticated' };
  }
  async listPhotos(): Promise<PhotoMeta[]> {
    return [];
  }
  async getOriginal(): Promise<GetOriginalResult> {
    this.fetches++;
    return { stream: Readable.from([this.bytes]), contentType: 'image/png', contentHash: this.hash };
  }
  async dispose(): Promise<void> {}
}

function meta(id: string, contentHash?: string): PhotoMeta {
  return { id, sourceName: 'fake', filename: 'a.png', width: 16, height: 16, favorite: false, contentHash };
}

describe('ImageService caching', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pico-svc-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('serves a repeat view from cache without re-fetching when meta carries a contentHash', async () => {
    const cache = new DiskImageCache(dir, 10);
    await cache.init();
    const svc = new ImageService(cache, 100, 64);
    const src = new CountingSource(await tinyPng(), 'irrelevant-byte-hash');
    const m = meta('fake:1', 'stable-id'); // source-provided identity

    const first = await svc.getImage(src, m, 8, 8, 'contain', 'jpeg', '');
    expect(first.hit).toBe(false);

    const second = await svc.getImage(src, m, 8, 8, 'contain', 'jpeg', '');
    expect(second.hit).toBe(true);
    expect(second.cacheKey).toBe(first.cacheKey); // same key for lookup + store
    expect(src.fetches).toBe(1); // the hit never touched the source
  });

  it('keys distinct sizes separately (a different viewport is a miss)', async () => {
    const cache = new DiskImageCache(dir, 10);
    await cache.init();
    const svc = new ImageService(cache, 100, 64);
    const src = new CountingSource(await tinyPng(), 'h');
    const m = meta('fake:2', 'stable-id');

    await svc.getImage(src, m, 8, 8, 'contain', 'jpeg', '');
    const other = await svc.getImage(src, m, 4, 4, 'contain', 'jpeg', '');
    expect(other.hit).toBe(false);
    expect(src.fetches).toBe(2);
  });

  it('falls back to a byte-hash key when the source provides no contentHash', async () => {
    const cache = new DiskImageCache(dir, 10);
    await cache.init();
    const svc = new ImageService(cache, 100, 64);
    const src = new CountingSource(await tinyPng(), 'byte-hash');
    const m = meta('fake:3'); // no identity → must fetch to compute the key

    const first = await svc.getImage(src, m, 8, 8, 'contain', 'jpeg', '');
    expect(first.hit).toBe(false);
    const second = await svc.getImage(src, m, 8, 8, 'contain', 'jpeg', '');
    expect(second.hit).toBe(true); // resize skipped...
    expect(src.fetches).toBe(2); // ...but the fetch still happened
  });
});
