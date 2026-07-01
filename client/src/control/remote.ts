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
      </div>
    </div>
  `;

  const statusEl = root.querySelector<HTMLElement>('#status')!;

  const updateStatus = (state: SlideshowState) => {
    const photo = state.photo;
    const parts = [photo?.album, photo?.takenAt?.slice(0, 10), photo?.title].filter(Boolean);
    statusEl.textContent = parts.join(' · ') || `${state.index + 1} / ${state.total}`;
    root.querySelector<HTMLButtonElement>('[data-action="toggle_pause"]')!.textContent = state.paused ? '▶' : '⏸';
  };

  const es = new SlideshowEventSource();
  es.onState(updateStatus);
  es.onConnect(() => statusEl.textContent = 'Connected');
  es.onDisconnect(() => statusEl.textContent = 'Reconnecting…');
  es.connect();

  root.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
    if (!btn) return;
    const action = btn.dataset['action'] as 'next' | 'prev' | 'toggle_pause';
    await api.control({ action });
  });
}
