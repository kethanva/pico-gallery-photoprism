import { describe, it, expect } from 'vitest';
import type { PhotoMeta, AuthStatus } from '@pico/shared';
import { SlideshowEngine } from './index.js';
import { RootConfigSchema } from '../config/index.js';
import type { PhotoSource, GetOriginalResult } from '../sources/source.js';

function photo(id: string): PhotoMeta {
  return { id, sourceName: 'directory', filename: `${id}.jpg`, width: 0, height: 0, favorite: false };
}

// Source whose returned list can change between refreshes (mimics a rescan).
class MutableSource implements PhotoSource {
  readonly name = 'directory';
  readonly displayName = 'Mutable';
  list: PhotoMeta[] = [photo('a'), photo('b'), photo('c')];
  async init(): Promise<void> {}
  async authStatus(): Promise<AuthStatus> { return { kind: 'authenticated' }; }
  async authenticate(): Promise<AuthStatus> { return { kind: 'authenticated' }; }
  async listPhotos(): Promise<PhotoMeta[]> { return this.list; }
  async getOriginal(): Promise<GetOriginalResult> { throw new Error('not used'); }
  async dispose(): Promise<void> {}
}

function buildEngine(src: PhotoSource) {
  // chronological + no schedule → playlist is stably [a,b,c…] and always "on".
  const cfg = RootConfigSchema.parse({ display: { order: 'chronological', onThisDayBoost: false } });
  return new SlideshowEngine(new Map([['directory', src]]), cfg);
}

describe('SlideshowEngine.refresh', () => {
  it('keeps the cursor on the current photo across a rebuild', async () => {
    const src = new MutableSource();
    const engine = buildEngine(src);
    await engine.start();
    engine.next(); // → index 1, photo 'b'
    expect(engine.getState().photo?.id).toBe('b');

    await engine.refresh();
    expect(engine.getState().photo?.id).toBe('b'); // unchanged
    expect(engine.getState().total).toBe(3);
    engine.stop();
  });

  it('picks up newly added photos without moving the cursor', async () => {
    const src = new MutableSource();
    const engine = buildEngine(src);
    await engine.start();
    engine.next(); // 'b'

    src.list = [photo('a'), photo('b'), photo('c'), photo('d')];
    await engine.refresh();

    expect(engine.getState().total).toBe(4);
    expect(engine.getState().photo?.id).toBe('b'); // cursor preserved
    expect(engine.getState().nextPhoto?.id).toBe('c');
    engine.stop();
  });

  it('falls back to the start if the current photo disappeared', async () => {
    const src = new MutableSource();
    const engine = buildEngine(src);
    await engine.start();
    engine.next(); // 'b'

    src.list = [photo('x'), photo('y')]; // 'b' gone
    await engine.refresh();

    expect(engine.getState().total).toBe(2);
    expect(engine.getState().index).toBe(0);
    engine.stop();
  });
});
