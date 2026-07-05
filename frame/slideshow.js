import { thumbUrl, slideshowSize } from './thumb.js';
import { shuffle } from './playlist.js';

/**
 * Two-layer crossfade slideshow. Preloads and decodes the next image before
 * swapping so transitions never block the main thread on a weak A53.
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
    this.schedule();
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
    clearInterval(this.timer);
    if (this.paused || this.order.length < 2) return;
    this.timer = setInterval(() => this.next(), this.slideDuration * 1000);
  }

  pause() {
    this.paused = true;
    clearInterval(this.timer);
  }

  resume() {
    this.paused = false;
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

    const nextLayer = 1 - this.active;
    const { el, img } = this.layers[nextLayer];
    const size = slideshowSize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    const src = thumbUrl(photo.hash, this.previewToken, size);

    const apply = () => {
      const prev = this.layers[this.active];
      prev.el.classList.remove('active');
      el.classList.add('animating', 'active');
      setTimeout(() => {
        el.classList.remove('animating');
        // Free decoded image memory on the inactive layer (critical on 512 MB Pi).
        prev.img.removeAttribute('src');
      }, 900);
      this.active = nextLayer;
      this.#preloadNext();
    };

    if (img.getAttribute('src') === src) {
      apply();
      return;
    }

    img.onload = () => {
      img.onload = null;
      apply();
    };
    img.onerror = () => {
      img.onerror = null;
      apply();
    };
    img.src = src;
  }

  #preloadNext() {
    if (this.order.length < 2) return;
    const next = this.order[(this.index + 1) % this.order.length];
    if (!next) return;
    const size = slideshowSize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    const src = thumbUrl(next.hash, this.previewToken, size);
    if (!this._preload) {
      this._preload = new Image();
      this._preload.decoding = 'async';
    }
    if (this._preload.src !== src) {
      this._preload.src = src;
      if (this._preload.decode) this._preload.decode().catch(() => {});
    }
  }

  hide() {
    this.root.classList.add('hidden');
    this.pause();
    for (const { img } of this.layers) img.removeAttribute('src');
  }

  reveal() {
    this.root.classList.remove('hidden');
    this.resume();
    this.show();
  }
}
