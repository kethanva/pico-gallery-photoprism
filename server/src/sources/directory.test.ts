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
    } finally {
      await src.dispose();
    }
  });
});
