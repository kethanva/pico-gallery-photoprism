export class ImageGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageGuardError';
  }
}

export function checkGuard(bytes: Buffer, maxMb: number, _maxMegapixels: number): void {
  const mbSize = bytes.length / (1024 * 1024);
  if (mbSize > maxMb) throw new ImageGuardError(`Image too large: ${mbSize.toFixed(1)} MB > ${maxMb} MB limit`);
}

export function checkPixels(width: number, height: number, maxMegapixels: number): void {
  const mp = (width * height) / 1_000_000;
  if (mp > maxMegapixels) throw new ImageGuardError(`Image too large: ${mp.toFixed(1)} MP > ${maxMegapixels} MP limit`);
}
