import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { savePersistedPhotoId, flushPersistedPhotoId, loadPersistedPhotoId } from './state-store.js';

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'pico-ss-'));
  dirs.push(d);
  return d;
}
const stateFile = (dir: string): string => join(dir, 'slideshow-state.json');
const readId = (dir: string): string => JSON.parse(readFileSync(stateFile(dir), 'utf-8')).photoId;

afterEach(() => {
  flushPersistedPhotoId(); // drain any pending timer so state can't leak between tests
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('state-store cursor persistence', () => {
  it('throttles: rapid saves do not each hit the disk', () => {
    vi.useFakeTimers();
    const dir = freshDir();
    savePersistedPhotoId(dir, 'a');
    savePersistedPhotoId(dir, 'b');
    savePersistedPhotoId(dir, 'c');
    expect(existsSync(stateFile(dir))).toBe(false); // deferred, not written yet
  });

  it('coalesces to the latest id when the pending write lands', () => {
    vi.useFakeTimers();
    const dir = freshDir();
    savePersistedPhotoId(dir, 'a');
    savePersistedPhotoId(dir, 'b');
    savePersistedPhotoId(dir, 'c');
    flushPersistedPhotoId(); // stand-in for the throttle window elapsing
    expect(readId(dir)).toBe('c');
  });

  it('flush writes synchronously for shutdown durability', () => {
    vi.useFakeTimers();
    const dir = freshDir();
    savePersistedPhotoId(dir, 'x');
    flushPersistedPhotoId();
    expect(readId(dir)).toBe('x'); // present with no timer advance
  });

  it('round-trips through loadPersistedPhotoId', async () => {
    const dir = freshDir();
    savePersistedPhotoId(dir, 'resume-me');
    flushPersistedPhotoId();
    expect(await loadPersistedPhotoId(dir)).toBe('resume-me');
  });

  it('flush is a no-op when nothing is pending', () => {
    const dir = freshDir();
    flushPersistedPhotoId();
    expect(existsSync(stateFile(dir))).toBe(false);
  });
});
