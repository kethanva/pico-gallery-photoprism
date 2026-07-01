import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../telemetry/logger.js';

interface PersistedState {
  photoId: string;
}

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

/** Fire-and-forget: never let a slow/broken disk block slideshow advancement. */
export function savePersistedPhotoId(cacheDir: string | undefined, photoId: string): void {
  const path = stateFilePath(cacheDir);
  void (async () => {
    try {
      await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify({ photoId } satisfies PersistedState), 'utf-8');
    } catch (err) {
      logger.debug({ err }, 'Failed to persist slideshow cursor');
    }
  })();
}
