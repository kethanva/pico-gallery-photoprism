// Playlist fetch and shuffle — host pre-pages the library so the browser
// never holds incremental search state or runs heavy merge logic.

/**
 * @typedef {{ hash: string, w: number, h: number, title: string, takenAt: string }} Photo
 */

/** @returns {Promise<Photo[]>} */
export async function fetchPlaylist() {
  const res = await fetch('/frame/playlist');
  if (!res.ok) throw new Error(`playlist ${res.status}`);
  return /** @type {Photo[]} */ (await res.json());
}

/**
 * Fisher-Yates shuffle (in-place copy).
 * @template T
 * @param {T[]} arr
 * @returns {T[]}
 */
export function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
