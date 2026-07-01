import { api } from '../api/client.js';

/**
 * Local physical keyboard control for the kiosk frame (a keyboard/mouse
 * plugged straight into the Pi, as opposed to the network `/remote` page).
 * Left/Right = prev/next, Space = pause/resume. Read-only: no photo mutation.
 */
export function bindFrameKeyboard(): void {
  window.addEventListener('keydown', (e) => {
    // Don't hijack browser/devtools shortcuts held with a modifier.
    if (e.altKey || e.ctrlKey || e.metaKey) return;

    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        void api.control({ action: 'prev' });
        break;
      case 'ArrowRight':
        e.preventDefault();
        void api.control({ action: 'next' });
        break;
      case ' ':
        e.preventDefault();
        void api.control({ action: 'toggle_pause' });
        break;
      default:
        break;
    }
  });
}
