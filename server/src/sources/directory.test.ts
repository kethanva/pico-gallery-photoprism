import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';
import { DirectorySource } from './directory.js';
import type { DirectoryConfig } from '../config/index.js';

const sampleDir = fileURLToPath(new URL('../../../sample_photos', import.meta.url));

function cfg(): DirectoryConfig {
  return { name: 'directory', enabled: true, paths: [sampleDir], recursive: true, rescanIntervalSecs: 3600, order: 'alphabetical' };
}

describe('DirectorySource', () => {
  it('scans the sample directory and reads EXIF capture date + dimensions', async () => {
    const src = new DirectorySource();
    await src.init(cfg());
    try {
      const photos = await src.listPhotos(100, 0);
      expect(photos.length).toBe(9);

      // Every photo gets a takenAt (EXIF date, or file mtime fallback).
      for (const p of photos) {
        expect(p.takenAt).toBeTruthy();
        expect(() => new Date(p.takenAt!).toISOString()).not.toThrow();
        expect(p.id.startsWith('directory:')).toBe(true);
        expect(p.album).toBe('sample_photos');
      }

      // At least one sample carries real EXIF dimensions (proves exifr is wired,
      // not just the mtime fallback).
      expect(photos.some((p) => p.width > 0 && p.height > 0)).toBe(true);

      // Every photo gets a stable cache identity (path+mtime+size) so repeat
      // views are served from cache without re-reading the file; distinct files
      // get distinct hashes.
      for (const p of photos) expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(new Set(photos.map((p) => p.contentHash)).size).toBe(photos.length);
    } finally {
      await src.dispose();
    }
  });
});
