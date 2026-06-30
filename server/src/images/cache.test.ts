import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DiskImageCache } from './cache.js';

const kb = (n: number) => Buffer.alloc(n * 1024, 1);
const imgs = async (dir: string) => (await readdir(dir)).filter((f) => f.endsWith('.img'));
const tick = () => new Promise((r) => setTimeout(r, 8)); // distinct put mtimes

describe('DiskImageCache', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pico-cache-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stores and retrieves by key', async () => {
    const c = new DiskImageCache(dir, 10);
    await c.init();
    await c.put('a', kb(10));
    expect((await c.get('a'))?.length).toBe(10 * 1024);
    expect(await c.has('a')).toBe(true);
    expect(await c.get('missing')).toBeNull();
  });

  it('evicts oldest-written entries once over the byte budget', async () => {
    const c = new DiskImageCache(dir, 1); // 1 MB = 1024 KB budget
    await c.init();
    await c.put('a', kb(400));
    await tick();
    await c.put('b', kb(400));
    await tick();
    await c.put('c', kb(400)); // 1200 KB > 1024 KB → evict oldest ('a')
    expect(await c.has('a')).toBe(false);
    expect(await c.get('a')).toBeNull();
    expect(await c.has('b')).toBe(true);
    expect(await c.has('c')).toBe(true);
    expect((await imgs(dir)).length).toBe(2);
  });

  it('re-putting a key overwrites instead of double-counting its size', async () => {
    const c = new DiskImageCache(dir, 1);
    await c.init();
    await c.put('a', kb(400));
    await c.put('a', kb(400)); // same key again — must not count as 800 KB
    await c.put('b', kb(400)); // total stays 800 KB < 1024 → nothing evicted
    expect(await c.has('a')).toBe(true);
    expect(await c.has('b')).toBe(true);
    expect((await imgs(dir)).length).toBe(2);
  });

  it('re-seeds size accounting from disk on init (survives restart)', async () => {
    const c1 = new DiskImageCache(dir, 1);
    await c1.init();
    await c1.put('a', kb(400));
    await c1.put('b', kb(400));

    const c2 = new DiskImageCache(dir, 1);
    await c2.init(); // picks up a+b (800 KB) via one stat pass
    await tick();
    await c2.put('c', kb(400)); // 1200 KB > 1024 KB → evicts one prior entry
    expect(await c2.has('c')).toBe(true);
    expect((await imgs(dir)).length).toBe(2);
  });
});
