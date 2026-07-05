// Thumbnail URL helpers — no dependencies, runs in WPE WebKit on Pi Zero 2.

const FIT_SIZES = [720, 1280, 1600, 1920, 2048, 2560, 3840, 4096, 5120, 7680];

/** @param {number} px */
export function snapFitSize(px) {
  for (const s of FIT_SIZES) {
    if (px <= s) return s;
  }
  return FIT_SIZES[FIT_SIZES.length - 1];
}

/**
 * @param {string} hash
 * @param {string} token previewToken from /api/v1/config
 * @param {string} size e.g. tile_224 or fit_1280
 */
export function thumbUrl(hash, token, size) {
  return `/api/v1/t/${hash}/${token}/${size}`;
}

/**
 * Slideshow image size for the current viewport.
 * @param {number} vw viewport width
 * @param {number} vh viewport height
 * @param {number} dpr devicePixelRatio
 */
export function slideshowSize(vw, vh, dpr) {
  // Pi Zero 2 W: cap decoded slideshow images at 1920px — larger fit sizes
  // decode slowly and exhaust the 512 MB shared RAM on WPE WebKit.
  const px = Math.min(Math.max(vw, vh) * (dpr || 1), 1920);
  return `fit_${snapFitSize(px)}`;
}
