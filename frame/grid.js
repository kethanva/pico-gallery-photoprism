import { thumbUrl } from './thumb.js';

const POOL_SIZE = 72; // fixed DOM budget for Pi Zero 2 (never grows with library size)
const COLS = 3;

/**
 * Virtualized photo grid — only POOL_SIZE cells exist in the DOM regardless of
 * library size. Off-screen cells clear img.src to free decoded image memory.
 */
export class PhotoGrid {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;
    this.root.className = 'grid-view';
    this.spacer = document.createElement('div');
    this.spacer.className = 'grid-spacer';
    this.root.appendChild(this.spacer);

    /** @type {import('./playlist.js').Photo[]} */
    this.photos = [];
    this.previewToken = 'public';
    this.cellSize = 120;
    this.rowCount = 0;

    /** @type {{ el: HTMLDivElement, img: HTMLImageElement, index: number }[]} */
    this.pool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const el = document.createElement('div');
      el.className = 'grid-cell';
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.loading = 'lazy';
      el.appendChild(img);
      el.addEventListener('click', () => this.#onCellClick(el));
      this.spacer.appendChild(el);
      this.pool.push({ el, img, index: -1 });
    }

    this._raf = 0;
    this._first = 0;
    this._last = -1;
    this.onSelect = null;

    this.root.addEventListener('scroll', () => this.#onScroll(), { passive: true });
    window.addEventListener('resize', () => this.#onResize(), { passive: true });
  }

  /** @param {import('./playlist.js').Photo[]} photos */
  setPhotos(photos) {
    this.photos = photos;
    this.#onResize();
  }

  /** @param {string} token */
  setPreviewToken(token) {
    this.previewToken = token || 'public';
  }

  #onResize() {
    this.cellSize = Math.floor(this.root.clientWidth / COLS) || 120;
    this.rowCount = Math.ceil(this.photos.length / COLS);
    this.spacer.style.height = `${this.rowCount * this.cellSize}px`;
    this.#layout();
  }

  #onScroll() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.#layout();
    });
  }

  #layout() {
    if (!this.photos.length) return;
    const scrollTop = this.root.scrollTop;
    const viewH = this.root.clientHeight;
    const buf = this.cellSize; // one row buffer above/below

    const firstRow = Math.max(0, Math.floor((scrollTop - buf) / this.cellSize));
    const lastRow = Math.min(this.rowCount - 1, Math.ceil((scrollTop + viewH + buf) / this.cellSize));
    const first = firstRow * COLS;
    const last = Math.min(this.photos.length - 1, (lastRow + 1) * COLS - 1);

    if (first === this._first && last === this._last) return;
    this._first = first;
    this._last = last;

    const needed = last - first + 1;
    const use = Math.min(needed, POOL_SIZE);

    for (let p = 0; p < POOL_SIZE; p++) {
      const slot = this.pool[p];
      if (p < use) {
        const idx = first + p;
        const photo = this.photos[idx];
        slot.index = idx;
        const col = idx % COLS;
        const row = Math.floor(idx / COLS);
        slot.el.style.width = `${this.cellSize}px`;
        slot.el.style.height = `${this.cellSize}px`;
        slot.el.style.transform = `translate(${col * this.cellSize}px, ${row * this.cellSize}px)`;
        slot.el.style.display = 'block';
        slot.el.dataset.index = String(idx);
        const src = thumbUrl(photo.hash, this.previewToken, 'tile_224');
        if (slot.img.getAttribute('src') !== src) {
          slot.img.src = src;
        }
      } else {
        slot.index = -1;
        slot.el.style.display = 'none';
        if (slot.img.src) slot.img.removeAttribute('src');
      }
    }
  }

  /** @param {HTMLDivElement} el */
  #onCellClick(el) {
    const idx = Number(el.dataset.index);
    if (Number.isFinite(idx) && this.onSelect) this.onSelect(idx);
  }

  show() {
    this.root.classList.add('visible');
    this.#onResize();
  }

  hide() {
    this.root.classList.remove('visible');
    // Release decoded images when grid is hidden (slideshow mode).
    for (const slot of this.pool) {
      if (slot.img.src) slot.img.removeAttribute('src');
    }
    // Invalidate the render window: with an unchanged scroll position the next
    // show() would early-return in #layout and leave every tile blank.
    this._first = 0;
    this._last = -1;
  }
}
