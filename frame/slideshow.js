import { thumbUrl, slideshowSize } from './thumb.js';
import { shuffle } from './playlist.js';

// Crossfade cleanup delay — must outlast the 0.8s CSS opacity transition.
const CROSSFADE_MS = 900;
// A load slower than this is abandoned and the show moves on (slow Wi-Fi guard).
const LOAD_TIMEOUT_MS = 20000;
// A failed slide skips forward quickly instead of holding a black frame.
const ERROR_SKIP_MS = 2000;

/**
 * Two-layer crossfade slideshow. Preloads and decodes the next image before
 * swapping so transitions never block the main thread on a weak A53.
 *
 * Scheduling: the advance timer is armed AFTER a slide has painted (in apply),
 * never on a fixed interval — a fixed interval would replace an in-flight
 * `img.src` before onload on slow networks, so nothing would ever paint.
 */
export class Slideshow {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;
    this.root.className = 'slideshow';
    this.layers = [this.#makeLayer(), this.#makeLayer()];
    this.layers.forEach((l) => this.root.appendChild(l.el));
    this.active = 0;
    /** @type {import('./playlist.js').Photo[]} */
    this.order = [];
    this.index = 0;
    this.previewToken = 'public';
    this.slideDuration = 10;
    this.timer = null;
    this.watchdog = null;
    this.paused = false;
    this.onShowGrid = null;
    /** @type {HTMLImageElement | null} */
    this._preload = null;
  }

  #makeLayer() {
    const el = document.createElement('div');
    el.className = 'slide-layer';
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.loading = 'eager';
    el.appendChild(img);
    return { el, img };
  }

  /**
   * @param {import('./playlist.js').Photo[]} photos
   * @param {number} [startIndex]
   */
  start(photos, startIndex = 0) {
    this.order = photos;
    this.index = startIndex % Math.max(photos.length, 1);
    this.show();
  }

  /** @param {string} token */
  setPreviewToken(token) {
    this.previewToken = token || 'public';
  }

  /** @param {number} secs */
  setSlideDuration(secs) {
    this.slideDuration = Math.max(3, secs || 10);
    if (!this.paused) this.schedule();
  }

  schedule() {
    clearTimeout(this.timer);
    if (this.paused || this.order.length < 2) return;
    this.timer = setTimeout(() => this.next(), this.slideDuration * 1000);
  }

  pause() {
    this.paused = true;
    clearTimeout(this.timer);
    this.root.classList.add('paused');
  }

  resume() {
    this.paused = false;
    this.root.classList.remove('paused');
    this.schedule();
  }

  togglePause() {
    if (this.paused) this.resume();
    else this.pause();
  }

  next() {
    if (!this.order.length) return;
    const nextIndex = this.index + 1;
    if (nextIndex >= this.order.length) {
      // Whole-library cycle complete — reshuffle before the next pass.
      this.order = shuffle(this.order.slice());
      this.index = 0;
    } else {
      this.index = nextIndex;
    }
    this.show();
  }

  prev() {
    if (!this.order.length) return;
    this.index = (this.index - 1 + this.order.length) % this.order.length;
    this.show();
  }

  /** @param {number} i */
  goTo(i) {
    if (!this.order.length) return;
    this.index = ((i % this.order.length) + this.order.length) % this.order.length;
    this.show();
  }

  show() {
    const photo = this.order[this.index];
    if (!photo) return;

    clearTimeout(this.timer);
    clearTimeout(this.watchdog);

    const nextLayer = 1 - this.active;
    const { el, img } = this.layers[nextLayer];
    const size = slideshowSize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    const src = thumbUrl(photo.hash, this.previewToken, size);

    const apply = () => {
      const prev = this.layers[this.active];
      const prevImg = prev.img;
      const prevSrc = prevImg.getAttribute('src');
      prev.el.classList.remove('active');
      el.classList.add('animating', 'active');
      setTimeout(() => {
        el.classList.remove('animating');
        // Free decoded image memory on the inactive layer (critical on 512 MB
        // Pi) — but never clobber a load that has since started on that layer.
        if (prevImg.getAttribute('src') === prevSrc) prevImg.removeAttribute('src');
      }, CROSSFADE_MS);
      this.active = nextLayer;
      this.#preloadNext();
      this.schedule();
    };

    if (img.getAttribute('src') === src) {
      apply();
      return;
    }

    const settle = (fn) => {
      img.onload = null;
      img.onerror = null;
      clearTimeout(this.watchdog);
      fn();
    };
    img.onload = () => settle(apply);
    img.onerror = () => settle(() => this.#skip());
    this.watchdog = setTimeout(() => settle(() => this.#skip()), LOAD_TIMEOUT_MS);
    img.src = src;
  }

  // A slide that failed or timed out moves on after a short beat; a full
  // slideDuration of black frame would read as a frozen frame.
  #skip() {
    clearTimeout(this.timer);
    if (this.paused || this.order.length < 2) return;
    this.timer = setTimeout(() => this.next(), ERROR_SKIP_MS);
  }

  #preloadNext() {
    if (this.order.length < 2) return;
    const next = this.order[(this.index + 1) % this.order.length];
    if (!next) return;
    const size = slideshowSize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    const src = thumbUrl(next.hash, this.previewToken, size);
    
    // Create a fresh Image instance for every preload to prevent WPE WebKit 
    // from accumulating decoded bitmap textures on a reused orphan node.
    this._preload = new Image();
    this._preload.decoding = 'async';
    this._preload.src = src;
    if (this._preload.decode) this._preload.decode().catch(() => {});
  }

  hide() {
    this.root.classList.add('hidden');
    this.pause();
    clearTimeout(this.watchdog);
    for (const { img } of this.layers) img.removeAttribute('src');
  }

  // Callers pair this with goTo()/show() — revealing alone does not reload the
  // layers hide() just cleared.
  reveal() {
    this.root.classList.remove('hidden');
    this.resume();
  }
}
