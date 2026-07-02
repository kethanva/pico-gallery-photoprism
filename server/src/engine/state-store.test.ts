import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { savePersistedState, flushPersistedState, loadPersistedState } from './state-store.js';

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'pico-ss-'));
  dirs.push(d);
  return d;
}
const stateFile = (dir: string): string => join(dir, 'slideshow-state.json');
const readState = (dir: string): { photoId?: string; seenIds?: string[]; cycle?: number } =>
  JSON.parse(readFileSync(stateFile(dir), 'utf-8'));

afterEach(() => {
  flushPersistedState(); // drain any pending timer so state can't leak between tests
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('state-store persistence', () => {
  it('throttles: rapid saves do not each hit the disk', () => {
    vi.useFakeTimers();
    const dir = freshDir();
    savePersistedState(dir, () => ({ photoId: 'a' }));
    savePersistedState(dir, () => ({ photoId: 'b' }));
    savePersistedState(dir, () => ({ photoId: 'c' }));
    expect(existsSync(stateFile(dir))).toBe(false); // deferred, not written yet
  });

  it('coalesces to the latest snapshot when the pending write lands', () => {
    vi.useFakeTimers();
    const dir = freshDir();
    savePersistedState(dir, () => ({ photoId: 'a' }));
    savePersistedState(dir, () => ({ photoId: 'b' }));
    savePersistedState(dir, () => ({ photoId: 'c' }));
    flushPersistedState(); // stand-in for the throttle window elapsing
    expect(readState(dir).photoId).toBe('c');
  });

  it('evaluates the snapshot getter only at write time', () => {
    vi.useFakeTimers();
    const dir = freshDir();
    let current = 'a';
    savePersistedState(dir, () => ({ photoId: current }));
    current = 'z'; // moved on before the throttle window elapsed
    flushPersistedState();
    expect(readState(dir).photoId).toBe('z');
  });

  it('flush writes synchronously for shutdown durability', () => {
    vi.useFakeTimers();
    const dir = freshDir();
    savePersistedState(dir, () => ({ photoId: 'x' }));
    flushPersistedState();
    expect(readState(dir).photoId).toBe('x'); // present with no timer advance
  });

  it('round-trips photoId, seenIds and cycle through loadPersistedState', async () => {
    const dir = freshDir();
    savePersistedState(dir, () => ({ photoId: 'resume-me', seenIds: ['p1', 'p2'], cycle: 3 }));
    flushPersistedState();
    const loaded = await loadPersistedState(dir);
    expect(loaded.photoId).toBe('resume-me');
    expect(loaded.seenIds).toEqual(['p1', 'p2']);
    expect(loaded.cycle).toBe(3);
  });

  it('loads an empty state when no file exists', async () => {
    const dir = freshDir();
    expect(await loadPersistedState(dir)).toEqual({});
  });

  it('loads the legacy cursor-only file shape', async () => {
    const dir = freshDir();
    savePersistedState(dir, () => ({ photoId: 'old' }));
    flushPersistedState();
    const loaded = await loadPersistedState(dir);
    expect(loaded.photoId).toBe('old');
    expect(loaded.seenIds).toBeUndefined();
  });

  it('flush is a no-op when nothing is pending', () => {
    const dir = freshDir();
    flushPersistedState();
    expect(existsSync(stateFile(dir))).toBe(false);
  });
});
