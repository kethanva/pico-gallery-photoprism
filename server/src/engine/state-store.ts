import { mkdir, readFile, writeFile } from 'fs/promises';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../telemetry/logger.js';

export interface PersistedSlideshowState {
  /** Last-shown photo id — the resume cursor. */
  photoId?: string;
  /** Photos already shown this cycle (no-repeat guarantee across restarts). */
  seenIds?: string[];
  /** Completed-cycle counter — salts the shuffle so each cycle reorders. */
  cycle?: number;
}

// The slideshow advances every few seconds, and state is persisted on every
// advance. Writing to the SD card that often is needless flash wear plus I/O that
// competes with image-cache reads, so coalesce writes: at most one per window.
// The snapshot getter is evaluated only when the write actually happens, so a
// 10k-entry seen-set is serialized once per window, not once per slide. Losing up
// to a window's worth of progress on an ungraceful power-cut is fine for a frame;
// a graceful shutdown flushes the exact state synchronously (flushPersistedState).
const PERSIST_THROTTLE_MS = 60_000;

let pending: { dir: string | undefined; get: () => PersistedSlideshowState } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function stateFilePath(cacheDir: string | undefined): string {
  const dir = cacheDir ?? join(homedir(), '.cache', 'picogallery');
  return join(dir, 'slideshow-state.json');
}

/** Load persisted slideshow state, best-effort ({} when missing/corrupt). */
export async function loadPersistedState(cacheDir: string | undefined): Promise<PersistedSlideshowState> {
  try {
    const raw = await readFile(stateFilePath(cacheDir), 'utf-8');
    const parsed = JSON.parse(raw) as PersistedSlideshowState;
    return {
      photoId: typeof parsed.photoId === 'string' ? parsed.photoId : undefined,
      seenIds: Array.isArray(parsed.seenIds) ? parsed.seenIds.filter((id) => typeof id === 'string') : undefined,
      cycle: typeof parsed.cycle === 'number' ? parsed.cycle : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Fire-and-forget state save, throttled to one disk write per window. Never
 * blocks slideshow advancement; a slow/broken disk only drops the update.
 * `get` is called at write time so the snapshot is always the freshest.
 */
export function savePersistedState(cacheDir: string | undefined, get: () => PersistedSlideshowState): void {
  pending = { dir: cacheDir, get };
  if (timer) return; // a write is already scheduled; it'll pick up the latest `pending`
  timer = setTimeout(() => {
    timer = null;
    const write = pending;
    pending = null;
    if (write) void writeAsync(write.dir, write.get());
  }, PERSIST_THROTTLE_MS);
  timer.unref?.(); // don't keep the process alive just to persist state
}

/**
 * Persist the pending state immediately and synchronously. Called on shutdown so
 * the exact current photo + seen-set survive a restart even though routine saves
 * are throttled. Synchronous so it completes before the process exits.
 */
export function flushPersistedState(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const write = pending;
  pending = null;
  if (!write) return;
  try {
    const path = stateFilePath(write.dir);
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(write.get()), 'utf-8');
  } catch (err) {
    logger.debug({ err }, 'Failed to flush slideshow state');
  }
}

async function writeAsync(cacheDir: string | undefined, state: PersistedSlideshowState): Promise<void> {
  const path = stateFilePath(cacheDir);
  try {
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(state), 'utf-8');
  } catch (err) {
    logger.debug({ err }, 'Failed to persist slideshow state');
  }
}
