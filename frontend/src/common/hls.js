// Lazy hls.js loader.
//
// hls.js is ~350 KB minified. It is deliberately NOT in the boot bundle: the
// frame's video path builds native <video><source> elements (see lightbox.vue
// createVideoElement) and nothing reads window.Hls until a video is actually
// opened, so parsing hls.js at boot only slowed the 512 MB Pi Zero 2 W. A
// photo-only frame now never downloads it at all.
//
// ensureHls() imports the library on demand (its own webpack chunk) and assigns
// window.Hls once, memoising the in-flight promise so concurrent callers share a
// single fetch. Call it when a video is about to play so window.Hls is ready for
// any HLS-capable consumer; the native-source path does not await it.

let hlsPromise = null;

export function ensureHls() {
  if (window.Hls) {
    return Promise.resolve(window.Hls);
  }

  if (!hlsPromise) {
    hlsPromise = import(/* webpackChunkName: "hls" */ "hls.js")
      .then((m) => {
        window.Hls = m.default;
        return m.default;
      })
      .catch(() => null);
  }

  return hlsPromise;
}

export default ensureHls;
