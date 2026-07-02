import { describe, it, expect } from 'vitest';
import type { PhotoMeta, AuthStatus } from '@pico/shared';
import type { PhotoSource, GetOriginalResult } from '../sources/source.js';
import { Playlist, PLAYLIST_PAGE_SIZE } from './playlist.js';
import { RootConfigSchema } from '../config/index.js';

function photo(id: string): PhotoMeta {
  return { id, sourceName: 'paged', filename: `${id}.jpg`, width: 0, height: 0, favorite: false };
}

/** Source with `total` photos that honors limit/offset like PhotoPrism does. */
class PagedSource implements PhotoSource {
  readonly name = 'paged';
  readonly displayName = 'Paged';
  readonly calls: Array<{ limit: number; offset: number }> = [];
  constructor(private readonly total: number) {}
  async init(): Promise<void> {}
  async authStatus(): Promise<AuthStatus> { return { kind: 'authenticated' }; }
  async authenticate(): Promise<AuthStatus> { return { kind: 'authenticated' }; }
  async listPhotos(limit: number, offset: number): Promise<PhotoMeta[]> {
    this.calls.push({ limit, offset });
    const ids: PhotoMeta[] = [];
    for (let i = offset; i < Math.min(offset + limit, this.total); i++) ids.push(photo(`p${i}`));
    return ids;
  }
  async getOriginal(): Promise<GetOriginalResult> { throw new Error('not used'); }
  async dispose(): Promise<void> {}
}

/** Broken source that ignores offset and always returns the same full page. */
class NonPagingSource implements PhotoSource {
  readonly name = 'paged';
  readonly displayName = 'NonPaging';
  async init(): Promise<void> {}
  async authStatus(): Promise<AuthStatus> { return { kind: 'authenticated' }; }
  async authenticate(): Promise<AuthStatus> { return { kind: 'authenticated' }; }
  async listPhotos(limit: number): Promise<PhotoMeta[]> {
    const ids: PhotoMeta[] = [];
    for (let i = 0; i < limit; i++) ids.push(photo(`p${i}`)); // same ids every call
    return ids;
  }
  async getOriginal(): Promise<GetOriginalResult> { throw new Error('not used'); }
  async dispose(): Promise<void> {}
}

const display = RootConfigSchema.parse({ display: { order: 'chronological', onThisDayBoost: false } }).display;

describe('Playlist.build pagination', () => {
  it('fetches beyond a single page so the whole library is used', async () => {
    const total = PLAYLIST_PAGE_SIZE * 2 + 500; // needs 3 pages
    const src = new PagedSource(total);
    const pl = await Playlist.build(new Map([['paged', src]]), display);
    expect(pl.length).toBe(total);
    expect(src.calls.length).toBe(3);
    expect(src.calls[1]?.offset).toBe(PLAYLIST_PAGE_SIZE);
  });

  it('stops after one page when the source is exhausted', async () => {
    const src = new PagedSource(42);
    const pl = await Playlist.build(new Map([['paged', src]]), display);
    expect(pl.length).toBe(42);
    expect(src.calls.length).toBe(1);
  });

  it('dedupes ids across pages (photo inserted mid-pagination shifts offsets)', async () => {
    const src = new PagedSource(PLAYLIST_PAGE_SIZE + 10);
    // Sabotage: second page starts 5 items early, duplicating 5 ids.
    const orig = src.listPhotos.bind(src);
    src.listPhotos = (limit: number, offset: number) => orig(limit, Math.max(0, offset - 5));
    const pl = await Playlist.build(new Map([['paged', src]]), display);
    const ids = pl.slice(0, pl.length).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length); // no dupes in the playlist
  });

  it('does not loop forever on a source that ignores offset', async () => {
    const src = new NonPagingSource();
    const pl = await Playlist.build(new Map([['paged', src]]), display);
    expect(pl.length).toBe(PLAYLIST_PAGE_SIZE); // one page kept, then bail
  });
});

describe('Playlist.peekNextUnseen', () => {
  it('skips seen photos when peeking ahead (prefetch alignment)', async () => {
    const src = new PagedSource(4); // p0..p3
    const pl = await Playlist.build(new Map([['paged', src]]), display);
    // cursor on p0; p1 and p2 already shown
    const next = pl.peekNextUnseen(new Set(['p1', 'p2']));
    expect(next?.id).toBe('p3');
  });

  it('falls back to the immediate neighbor when everything is seen', async () => {
    const src = new PagedSource(3);
    const pl = await Playlist.build(new Map([['paged', src]]), display);
    const next = pl.peekNextUnseen(new Set(['p0', 'p1', 'p2']));
    expect(next?.id).toBe('p1'); // cycle will reset; next() lands on the neighbor
  });
});
