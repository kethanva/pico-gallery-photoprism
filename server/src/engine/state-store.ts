import { mkdir, readFile, writeFile } from 'fs/promises';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../telemetry/logger.js';

interface PersistedState {
  photoId: string;
}

// The slideshow advances every few seconds, and the cursor is persisted on every
// advance. Writing to the SD card that often is needless flash wear plus I/O that
// competes with image-cache reads, so coalesce writes: at most one per window,
// carrying whichever photo is current when the window elapses. Losing up to a
// window's worth of progress on an ungraceful power-cut is fine for a frame; a
// graceful shutdown flushes the exact cursor synchronously (flushPersistedPhotoId).
const PERSIST_THROTTLE_MS = 60_000;

let pending: { dir: string | undefined; id: string } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function stateFilePath(cacheDir: string | undefined): string {
  const dir = cacheDir ?? join(homedir(), '.cache', 'picogallery');
  return join(dir, 'slideshow-state.json');
}

/** Resume cursor across restarts: last-shown photo id, best-effort. */
export async function loadPersistedPhotoId(cacheDir: string | undefined): Promise<string | undefined> {
  try {
    const raw = await readFile(stateFilePath(cacheDir), 'utf-8');
    const parsed = JSON.parse(raw) as PersistedState;
    return parsed.photoId;
  } catch {
    return undefined;
  }
}

/**
 * Fire-and-forget cursor save, throttled to one disk write per window. Never
 * blocks slideshow advancement; a slow/broken disk only drops the update.
 */
export function savePersistedPhotoId(cacheDir: string | undefined, photoId: string): void {
  pending = { dir: cacheDir, id: photoId };
  if (timer) return; // a write is already scheduled; it'll pick up the latest `pending`
  timer = setTimeout(() => {
    timer = null;
    const write = pending;
    pending = null;
    if (write) void writeAsync(write.dir, write.id);
  }, PERSIST_THROTTLE_MS);
  timer.unref?.(); // don't keep the process alive just to persist a cursor
}

/**
 * Persist the pending cursor immediately and synchronously. Called on shutdown so
 * the exact current photo survives a restart even though routine saves are
 * throttled. Synchronous so it completes before the process exits.
 */
export function flushPersistedPhotoId(): void {
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
    writeFileSync(path, JSON.stringify({ photoId: write.id } satisfies PersistedState), 'utf-8');
  } catch (err) {
    logger.debug({ err }, 'Failed to flush slideshow cursor');
  }
}

async function writeAsync(cacheDir: string | undefined, photoId: string): Promise<void> {
  const path = stateFilePath(cacheDir);
  try {
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ photoId } satisfies PersistedState), 'utf-8');
  } catch (err) {
    logger.debug({ err }, 'Failed to persist slideshow cursor');
  }
}
