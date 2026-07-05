// Shared helper for the appliance kiosk slideshow (?kiosk=true).
//
// The boot slideshow plays the grid page that page/photos.vue and
// page/album/photos.vue have ALREADY loaded (Photo.batchSize() photos) — see
// each page's loadKioskSlideshow. It is deliberately NOT re-fetched from the
// whole library first: paging the entire library up front (thousands of photos,
// several MB of JSON) and building a Thumb — with a URL for every thumbnail size
// — for each one synchronously froze the 512 MB Pi Zero 2 W main thread for
// seconds before the first slide. That freeze swallowed taps and stalled the
// jump to fullscreen, i.e. the "slow / unusable, clicks do nothing" symptom.
// PhotoSwipe lazy-loads each image, so the already-loaded page is all the frame
// needs to start playing effectively instantly.
//
// Only `shuffled` (the library-order randomiser) lives here now.

// shuffled returns a new Fisher–Yates-shuffled copy (input left untouched) so
// every boot plays a different order.
export function shuffled(arr) {
  const out = arr.slice();

  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  return out;
}
