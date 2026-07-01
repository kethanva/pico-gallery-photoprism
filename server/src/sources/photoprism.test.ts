import { describe, it, expect } from 'vitest';
import { PhotoPrismSource, snapThumbSize } from './photoprism.js';
import type { PhotoPrismConfig } from '../config/index.js';

// buildSearchParams is private; exercise it via a typed cast. This guards the
// filter → PhotoPrism param mapping (several were previously dropped silently).
function paramsFor(partial: Partial<PhotoPrismConfig>): URLSearchParams {
  const src = new PhotoPrismSource();
  const cfg = {
    name: 'photoprism', enabled: true, url: 'http://pp', username: 'u',
    includePrivate: false, includeArchived: false, order: 'newest',
    skipTlsVerify: false, requestTimeoutSecs: 30,
    ...partial,
  } as PhotoPrismConfig;
  (src as unknown as { cfg: PhotoPrismConfig }).cfg = cfg;
  return (src as unknown as { buildSearchParams(l: number, o: number): URLSearchParams }).buildSearchParams(50, 0);
}

describe('PhotoPrism buildSearchParams', () => {
  it('maps geo/color/keyword/orientation/media filters that used to be dropped', () => {
    const p = paramsFor({
      state: 'Tuscany', city: 'Florence', color: 'blue',
      keywords: ['sunset', 'beach'], orientation: 'portrait', mediaType: 'video',
    });
    expect(p.get('state')).toBe('Tuscany');
    expect(p.get('city')).toBe('Florence');
    expect(p.get('color')).toBe('blue');
    expect(p.get('keywords')).toBe('sunset beach');
    expect(p.get('portrait')).toBe('true');
    expect(p.get('type')).toBe('video');
  });

  it('falls back to the first of albums[] when album is unset', () => {
    expect(paramsFor({ albums: ['Italy', 'Spain'] }).get('album')).toBe('Italy');
    expect(paramsFor({ album: 'Primary', albums: ['Italy'] }).get('album')).toBe('Primary');
  });

  it('applies the private/archived guards by default', () => {
    const p = paramsFor({});
    expect(p.get('public')).toBe('true');
    expect(p.get('archived')).toBe('false');
  });
});

describe('snapThumbSize', () => {
  const REGISTERED = new Set([720, 1280, 1600, 1920, 2048, 2560, 3840, 4096, 5120, 7680]);

  it('clamps below-minimum requests up to fit_720 (never the invalid fit_320)', () => {
    // The 64px letterbox-blur backdrop must resolve to a real PhotoPrism size.
    expect(snapThumbSize(64)).toBe(720);
    expect(snapThumbSize(1)).toBe(720);
    expect(snapThumbSize(720)).toBe(720);
  });

  it('snaps up to the nearest registered fit size', () => {
    expect(snapThumbSize(1080)).toBe(1280); // 1080p panel
    expect(snapThumbSize(1920)).toBe(1920);
    expect(snapThumbSize(2000)).toBe(2048);
    expect(snapThumbSize(1400)).toBe(1600);
  });

  it('caps at the largest registered size', () => {
    expect(snapThumbSize(9000)).toBe(7680);
  });

  it('only ever returns a registered PhotoPrism size', () => {
    for (let px = 1; px <= 8000; px += 37) {
      expect(REGISTERED.has(snapThumbSize(px))).toBe(true);
    }
  });
});
