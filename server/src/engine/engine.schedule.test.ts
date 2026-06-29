import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PhotoMeta, AuthStatus, SseEvent } from '@pico/shared';
import { SlideshowEngine } from './index.js';
import { bus } from './bus.js';
import { RootConfigSchema } from '../config/index.js';
import type { PhotoSource, GetOriginalResult } from '../sources/source.js';

function photo(id: string): PhotoMeta {
  return { id, sourceName: 'directory', filename: `${id}.jpg`, width: 0, height: 0, favorite: false };
}

class FakeSource implements PhotoSource {
  readonly name = 'directory';
  readonly displayName = 'Fake';
  async init(): Promise<void> {}
  async authStatus(): Promise<AuthStatus> { return { kind: 'authenticated' }; }
  async authenticate(): Promise<AuthStatus> { return { kind: 'authenticated' }; }
  async listPhotos(): Promise<PhotoMeta[]> { return [photo('a'), photo('b'), photo('c')]; }
  async getOriginal(): Promise<GetOriginalResult> { throw new Error('not used'); }
  async dispose(): Promise<void> {}
}

function buildEngine(slideSecs: number) {
  // chronological order keeps the playlist stable as [a,b,c] for assertions.
  const cfg = RootConfigSchema.parse({
    display: { slideDurationSecs: slideSecs, order: 'chronological', onThisDayBoost: false, schedule: { on: '08:00', off: '22:00' } },
  });
  const sources = new Map<string, PhotoSource>([['directory', new FakeSource()]]);
  return new SlideshowEngine(sources, cfg);
}

afterEach(() => vi.useRealTimers());

describe('SlideshowEngine display schedule', () => {
  it('starts with the display off when outside the on-window and does not advance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-29T23:00:00')); // outside 08:00–22:00 → off
    const engine = buildEngine(1);
    await engine.start();

    expect(engine.getState().displayOn).toBe(false);
    expect(engine.getState().index).toBe(0);

    vi.advanceTimersByTime(5000); // several slide ticks would fire, but display is off
    expect(engine.getState().index).toBe(0);
    engine.stop();
  });

  it('emits a display event and resumes advancing when the window opens', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-29T23:00:00')); // off
    const events: SseEvent[] = [];
    const unsub = bus.subscribe((e) => events.push(e));

    const engine = buildEngine(3600); // long slide so only the schedule check fires below
    await engine.start();
    expect(engine.getState().displayOn).toBe(false);

    vi.setSystemTime(new Date('2026-06-29T10:00:00')); // inside window → on
    vi.advanceTimersByTime(30_000); // schedule re-check interval

    expect(events.some((e) => e.type === 'display' && e.data.on === true)).toBe(true);
    expect(engine.getState().displayOn).toBe(true);

    vi.advanceTimersByTime(3_600_000); // one slide interval now that the display is on
    expect(engine.getState().index).toBe(1);

    unsub();
    engine.stop();
  });
});
