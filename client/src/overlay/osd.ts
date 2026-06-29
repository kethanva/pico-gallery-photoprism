import type { SlideshowState } from '@pico/shared';

export class OSDOverlay {
  private pill: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(root: HTMLElement) {
    this.pill = document.createElement('div');
    this.pill.className = 'osd-pill';
    this.pill.setAttribute('aria-live', 'polite');
    root.appendChild(this.pill);
  }

  show(state: SlideshowState): void {
    const photo = state.photo;
    if (!photo) return;

    const parts = [photo.album, photo.takenAt?.slice(0, 10), photo.filename, photo.title, photo.location].filter(
      Boolean
    );
    this.pill.textContent = parts.join(' · ');
    this.pill.classList.add('visible');

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.pill.classList.remove('visible'), 5000);
  }

  hide(): void {
    this.pill.classList.remove('visible');
  }
}
