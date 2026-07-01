import type { SlideshowState, DisplayConfig } from '@pico/shared';
import { imageUrl } from '../api/client.js';
import { preloadImage } from './preload.js';
import { applyKenBurns } from './kenburns.js';
import { runTransition } from './transitions.js';

export class SlideshowStage {
  private layers: [HTMLElement, HTMLElement];
  private activeIdx = 0;
  // Monotonic token identifying the most recent show() call. show() is async and
  // its callers (SSE state events, the resize handler) don't serialize, so two
  // can overlap. Each call checks it still owns the latest token after every
  // await; if a newer show() has started, the older one bails before it mutates
  // shared layer state — otherwise both would target the same layer and the
  // double activeIdx flip would desync the cross-fade.
  private showSeq = 0;

  constructor(private readonly root: HTMLElement) {
    this.layers = [this.makeLayer(), this.makeLayer()];
    root.append(this.layers[0], this.layers[1]);
  }

  async show(state: SlideshowState, cfg: DisplayConfig): Promise<void> {
    const photo = state.photo;
    if (!photo) return;

    const gen = ++this.showSeq;

    const w = window.innerWidth;
    const h = window.innerHeight;
    const src = imageUrl(photo.id, w, h, cfg.fillScreen ? 'cover' : 'contain');

    let img: HTMLImageElement;
    try {
      img = await preloadImage(src);
    } catch {
      return;
    }
    if (gen !== this.showSeq) return; // a newer show() superseded us during preload

    const entering = this.layers[this.activeIdx ^ 1]!;
    const leaving = this.layers[this.activeIdx]!;

    entering.innerHTML = '';
    // Letterbox blur fill: an ambient blur behind the contained photo, so empty
    // bars read as atmosphere not black. Pulled from a 64px thumbnail, not the
    // full-size `src`: a heavy blur of a tiny upscaled image is visually identical
    // but spares the Pi Zero 2's GPU a second full-resolution decode + texture
    // upload on every slide.
    if (cfg.letterboxBlur && !cfg.fillScreen) {
      const bg = document.createElement('div');
      bg.className = 'slide-bg';
      bg.style.backgroundImage = `url("${imageUrl(photo.id, 64, 64, 'cover')}")`;
      entering.appendChild(bg);
    }
    entering.appendChild(img);
    applyKenBurns(entering, cfg.kenBurns);

    await runTransition(entering, leaving, cfg.transition, cfg.transitionMs);
    if (gen !== this.showSeq) return; // superseded mid-transition — let the newer show() own the flip

    leaving.innerHTML = '';
    this.activeIdx ^= 1;
  }

  private makeLayer(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'slide-layer';
    return el;
  }
}
