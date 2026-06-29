import '../styles/tokens.css';
import '../styles/remote.css';
import { api } from '../api/client.js';
import { SlideshowEventSource } from '../api/events.js';
import type { SlideshowState } from '@pico/shared';

export function mountRemote(root: HTMLElement): void {
  root.innerHTML = `
    <div class="remote">
      <p class="remote__status" id="status">Connecting…</p>
      <div class="remote__controls">
        <button class="remote__btn" data-action="prev" aria-label="Previous">⏮</button>
        <button class="remote__btn" data-action="toggle_pause" aria-label="Pause/Resume">⏸</button>
        <button class="remote__btn" data-action="next" aria-label="Next">⏭</button>
        <button class="remote__btn" data-action="favorite" aria-label="Favorite">♡</button>
      </div>
    </div>
  `;

  const statusEl = root.querySelector<HTMLElement>('#status')!;
  const favBtn = root.querySelector<HTMLButtonElement>('[data-action="favorite"]')!;
  let currentPhotoId: string | null = null;
  let paused = false;

  const updateStatus = (state: SlideshowState) => {
    currentPhotoId = state.photo?.id ?? null;
    paused = state.paused;
    const photo = state.photo;
    const parts = [photo?.album, photo?.takenAt?.slice(0, 10), photo?.title].filter(Boolean);
    statusEl.textContent = parts.join(' · ') || `${state.index + 1} / ${state.total}`;
    favBtn.textContent = state.photo?.favorite ? '♥' : '♡';
    root.querySelector<HTMLButtonElement>('[data-action="toggle_pause"]')!.textContent = paused ? '▶' : '⏸';
  };

  const es = new SlideshowEventSource();
  es.onState(updateStatus);
  es.onConnect(() => statusEl.textContent = 'Connected');
  es.onDisconnect(() => statusEl.textContent = 'Reconnecting…');
  es.connect();

  root.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
    if (!btn) return;
    const action = btn.dataset['action'] as string;
    if (action === 'favorite' && currentPhotoId) {
      await api.control({ action: 'favorite', id: currentPhotoId });
    } else {
      await api.control({ action: action as 'next' | 'prev' | 'toggle_pause' });
    }
  });
}
