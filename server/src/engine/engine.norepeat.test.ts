import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { PhotoMeta, AuthStatus } from '@pico/shared';
import { SlideshowEngine } from './index.js';
import { RootConfigSchema } from '../config/index.js';
import type { PhotoSource, GetOriginalResult } from '../sources/source.js';

const cacheDirs: string[] = [];
function freshCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pico-nr-'));
  cacheDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of cacheDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function photo(id: string): PhotoMeta {
  return { id, sourceName: 'directory', filename: `${id}.jpg`, width: 0, height: 0, favorite: false };
}

class FixedSource implements PhotoSource {
  readonly name = 'directory';
  readonly displayName = 'Fixed';
  constructor(private readonly ids: string[]) {}
  async init(): Promise<void> {}
  async authStatus(): Promise<AuthStatus> { return { kind: 'authenticated' }; }
  async authenticate(): Promise<AuthStatus> { return { kind: 'authenticated' }; }
  async listPhotos(): Promise<PhotoMeta[]> { return this.ids.map(photo); }
  async getOriginal(): Promise<GetOriginalResult> { throw new Error('not used'); }
  async dispose(): Promise<void> {}
}

function buildEngine(ids: string[], cacheDir: string): SlideshowEngine {
  // chronological + no boost → playlist order is exactly `ids`; no schedule → always on.
  const cfg = RootConfigSchema.parse({
    display: { order: 'chronological', onThisDayBoost: false },
    cache: { dir: cacheDir },
  });
  return new SlideshowEngine(new Map([['directory', new FixedSource(ids)]]), cfg);
}

describe('SlideshowEngine no-repeat cycling', () => {
  it('shows every photo exactly once per cycle', async () => {
    const engine = buildEngine(['a', 'b', 'c', 'd'], freshCacheDir());
    await engine.start();
    const shown = [engine.getState().photo?.id];
    for (let i = 0; i < 3; i++) {
      engine.next();
      shown.push(engine.getState().photo?.id);
    }
    expect([...shown].sort()).toEqual(['a', 'b', 'c', 'd']); // all shown, none twice
    engine.stop();
  });

  it('starts a new cycle after every photo has been shown', async () => {
    const engine = buildEngine(['a', 'b', 'c'], freshCacheDir());
    await engine.start(); // shows a
    engine.next(); // b
    engine.next(); // c — cycle complete
    engine.next(); // new cycle begins
    expect(engine.getState().photo?.id).toBe('a');
    engine.stop();
  });

  it('skips photos already shown when the cursor moves backwards', async () => {
    const engine = buildEngine(['a', 'b', 'c', 'd'], freshCacheDir());
    await engine.start(); // a
    engine.next(); // b
    engine.next(); // c
    engine.prev(); // back to b (deliberate re-view, allowed)
    expect(engine.getState().photo?.id).toBe('b');
    engine.next(); // auto-advance must skip already-shown c → d
    expect(engine.getState().photo?.id).toBe('d');
    engine.stop();
  });

  it('remembers shown photos across a restart', async () => {
    const dir = freshCacheDir();
    const first = buildEngine(['a', 'b', 'c', 'd'], dir);
    await first.start(); // a
    first.next(); // b
    first.stop(); // flushes { photoId: b, seen: [a, b] }

    const second = buildEngine(['a', 'b', 'c', 'd'], dir);
    await second.start(); // resumes on b
    expect(second.getState().photo?.id).toBe('b');
    second.next();
    expect(second.getState().photo?.id).toBe('c'); // not a — a was already shown
    second.next();
    expect(second.getState().photo?.id).toBe('d');
    second.next(); // cycle complete → reset
    expect(second.getState().photo?.id).toBe('a');
    second.stop();
  });

  it('survives a playlist refresh without repeating shown photos', async () => {
    const engine = buildEngine(['a', 'b', 'c', 'd'], freshCacheDir());
    await engine.start(); // a
    engine.next(); // b
    await engine.refresh(); // rebuild (same photos), cursor anchored on b
    engine.next();
    engine.next();
    const after = engine.getState().photo?.id;
    expect(after).toBe('d'); // walked c then d; a/b not repeated
    engine.stop();
  });

  it('prefetch hint (nextPhoto) skips already-shown photos', async () => {
    const engine = buildEngine(['a', 'b', 'c', 'd'], freshCacheDir());
    await engine.start(); // a
    engine.next(); // b
    engine.next(); // c
    engine.prev(); // back on b; c already shown
    expect(engine.getState().nextPhoto?.id).toBe('d'); // what next() will land on
    engine.stop();
  });

  it('handles a single-photo library without stalling', async () => {
    const engine = buildEngine(['only'], freshCacheDir());
    await engine.start();
    engine.next();
    expect(engine.getState().photo?.id).toBe('only');
    engine.stop();
  });
});
