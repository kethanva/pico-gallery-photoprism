import type { SlideshowState, DisplayConfig } from '@pico/shared';
import { imageUrl } from '../api/client.js';
import { preloadImage } from './preload.js';
import { applyKenBurns } from './kenburns.js';
import { runTransition } from './transitions.js';

export class SlideshowStage {
  private layers: [HTMLElement, HTMLElement];
  private activeIdx = 0;

  constructor(private readonly root: HTMLElement) {
    this.layers = [this.makeLayer(), this.makeLayer()];
    root.append(this.layers[0], this.layers[1]);
  }

  async show(state: SlideshowState, cfg: DisplayConfig): Promise<void> {
    const photo = state.photo;
    if (!photo) return;

    const w = window.innerWidth;
    const h = window.innerHeight;
    const src = imageUrl(photo.id, w, h, cfg.fillScreen ? 'cover' : 'contain');

    let img: HTMLImageElement;
    try {
      img = await preloadImage(src);
    } catch {
      return;
    }

    const entering = this.layers[this.activeIdx ^ 1]!;
    const leaving = this.layers[this.activeIdx]!;

    entering.innerHTML = '';
    // Letterbox blur fill: a blurred, cover-scaled copy of the same (cached) image
    // behind the contained photo, so empty bars become an ambient blur not black.
    if (cfg.letterboxBlur && !cfg.fillScreen) {
      const bg = document.createElement('div');
      bg.className = 'slide-bg';
      bg.style.backgroundImage = `url("${src}")`;
      entering.appendChild(bg);
    }
    entering.appendChild(img);
    applyKenBurns(entering, cfg.kenBurns);

    await runTransition(entering, leaving, cfg.transition, cfg.transitionMs);

    leaving.innerHTML = '';
    this.activeIdx ^= 1;
  }

  private makeLayer(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'slide-layer';
    return el;
  }
}
