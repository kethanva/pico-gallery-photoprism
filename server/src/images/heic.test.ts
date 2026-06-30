import { describe, it, expect } from 'vitest';
import { isHeic } from './heic.js';

/** Build a fake ISO-BMFF header: [size][ftyp][brand]. */
function ftyp(brand: string): Buffer {
  const head = Buffer.from([0, 0, 0, 0x18]);
  return Buffer.concat([head, Buffer.from('ftyp'), Buffer.from(brand), Buffer.alloc(8)]);
}

describe('isHeic', () => {
  it('detects HEIC still-image brands', () => {
    for (const brand of ['heic', 'heix', 'mif1', 'heif']) {
      expect(isHeic(ftyp(brand))).toBe(true);
    }
  });

  it('rejects AVIF (sharp decodes it natively)', () => {
    expect(isHeic(ftyp('avif'))).toBe(false);
  });

  it('rejects a JPEG SOI marker', () => {
    expect(isHeic(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
  });

  it('rejects buffers too short to hold an ftyp box', () => {
    expect(isHeic(Buffer.from([0, 1, 2]))).toBe(false);
  });
});
