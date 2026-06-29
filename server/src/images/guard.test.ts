import { describe, it, expect } from 'vitest';
import { checkGuard, checkPixels, ImageGuardError } from './guard.js';

describe('checkGuard (byte size)', () => {
  it('passes an image under the MB limit', () => {
    expect(() => checkGuard(Buffer.alloc(1024 * 1024), 10, 64)).not.toThrow();
  });

  it('throws ImageGuardError over the MB limit', () => {
    const tooBig = Buffer.alloc(11 * 1024 * 1024);
    expect(() => checkGuard(tooBig, 10, 64)).toThrow(ImageGuardError);
  });
});

describe('checkPixels (megapixels)', () => {
  it('passes under the megapixel limit', () => {
    expect(() => checkPixels(2000, 1500, 64)).not.toThrow(); // 3 MP
  });

  it('throws over the megapixel limit', () => {
    expect(() => checkPixels(12000, 8000, 64)).toThrow(ImageGuardError); // 96 MP
  });
});
