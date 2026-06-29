import { describe, it, expect } from 'vitest';
import { PhotoPrismSource } from './photoprism.js';
import type { PhotoPrismConfig } from '../config/index.js';

// buildSearchParams is private; exercise it via a typed cast. This guards the
// filter → PhotoPrism param mapping (several were previously dropped silently).
function paramsFor(partial: Partial<PhotoPrismConfig>): URLSearchParams {
  const src = new PhotoPrismSource();
  const cfg = {
    name: 'photoprism', enabled: true, url: 'http://pp', username: 'u',
    includePrivate: false, includeArchived: false, order: 'newest',
    perPage: 100, maxThumb: 'fit_1920', skipTlsVerify: false, requestTimeoutSecs: 30,
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
