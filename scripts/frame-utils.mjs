// Shared helpers for the lightweight frame client and host playlist builder.
// PhotoPrism only serves registered fit_ sizes; clamp to the nearest valid one.
// https://docs.photoprism.app/developer-guide/api/thumbnails/

export const FIT_SIZES = [720, 1280, 1600, 1920, 2048, 2560, 3840, 4096, 5120, 7680];

/** @param {number} px */
export function snapFitSize(px) {
  for (const s of FIT_SIZES) {
    if (px <= s) return s;
  }
  return FIT_SIZES[FIT_SIZES.length - 1];
}

/**
 * Compact a PhotoPrism photo record for the frame playlist.
 * @param {Record<string, unknown>} photo
 */
export function compactPhoto(photo) {
  let hash = photo.Hash || photo.hash;
  if (!hash && Array.isArray(photo.Files)) {
    const files = photo.Files;
    const primary = files.find((f) => f.Primary && f.Hash);
    const image = files.find((f) => (f.Type === 'image' || f.FileType === 'image') && !f.Missing && f.Hash);
    const any = files.find((f) => f.Hash);
    hash = (primary || image || any)?.Hash;
  }
  if (!hash) return null;
  return {
    hash: String(hash),
    w: Number(photo.Width || photo.width || 0),
    h: Number(photo.Height || photo.height || 0),
    title: String(photo.Title || photo.title || ''),
    takenAt: String(photo.TakenAt || photo.takenAt || ''),
  };
}

/**
 * Fisher-Yates shuffle (in-place).
 * @template T
 * @param {T[]} arr
 * @returns {T[]}
 */
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
