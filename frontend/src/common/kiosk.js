import { Photo } from "model/photo";

// Shared helpers for the appliance kiosk slideshow (?kiosk=true). Used by
// page/photos.vue (whole library, shuffled) and page/album/photos.vue (whole
// album, curated order) so the pagination logic exists exactly once.

export const KIOSK_FETCH_COUNT = 1000; // photos per request — few round-trips
export const KIOSK_MAX_PHOTOS = 10000; // safety cap for the 512MB Pi Zero 2

// fetchAllPhotos pages through a photo search and resolves with every matching
// model (up to KIOSK_MAX_PHOTOS). The caller must pass a STABLE `order` in
// `base` — offset-paginating `order=random` returns duplicates and gaps
// because PhotoPrism re-seeds the random ordering on every request.
//
// Termination compares against the page size the backend actually applied
// (X-Limit) rather than the requested count: a backend that clamps pages below
// KIOSK_FETCH_COUNT would otherwise look like an exhausted library after one
// page. Errors resolve with whatever was accumulated so far — the caller
// decides on a fallback.
export function fetchAllPhotos(base) {
  const fetchPage = (offset, acc) => {
    if (acc.length >= KIOSK_MAX_PHOTOS) {
      return Promise.resolve(acc);
    }

    return Photo.search({ ...base, count: KIOSK_FETCH_COUNT, offset })
      .then((resp) => {
        const models = resp && Array.isArray(resp.models) ? resp.models : [];
        if (models.length === 0) {
          return acc;
        }

        acc.push(...models);

        const pageSize = resp.limit > 0 ? Math.min(resp.limit, KIOSK_FETCH_COUNT) : KIOSK_FETCH_COUNT;
        if (models.length < pageSize) {
          return acc; // short page → library exhausted
        }

        return fetchPage(offset + models.length, acc);
      })
      .catch(() => acc);
  };

  return fetchPage(0, []);
}

// shuffled returns a new Fisher–Yates-shuffled copy (input left untouched) so
// every boot plays a different, non-repeating order.
export function shuffled(arr) {
  const out = arr.slice();

  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  return out;
}
