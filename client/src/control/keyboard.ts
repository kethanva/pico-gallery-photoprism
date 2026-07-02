import { api } from '../api/client.js';

/** PhotoPrism-host port on the standard two-service appliance (see install.sh). */
const PHOTOPRISM_UI_PORT = 8190;

/**
 * Resolve where Esc sends the frame: the configured PhotoPrism UI URL, or — when
 * unset — the same host on the PhotoPrism-host port. Pure (no DOM) so it is easy
 * to reason about and unit-test.
 */
export function resolvePhotoprismUrl(
  cfg: { photoprismUrl?: string },
  loc: { protocol: string; hostname: string },
): string {
  const configured = cfg.photoprismUrl?.trim();
  if (configured) return configured;
  return `${loc.protocol}//${loc.hostname}:${PHOTOPRISM_UI_PORT}/`;
}

export interface FrameKeyboardOptions {
  /** PhotoPrism UI URL to open when Esc is pressed (from DisplayConfig). */
  photoprismUrl?: string;
}

/** Toggle browser native fullscreen on the root document element. */
function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  }
}

/**
 * Local physical keyboard control for the kiosk frame (a keyboard/mouse plugged
 * straight into the Pi, as opposed to the network `/remote` page).
 * Left/Right = prev/next, Space = pause/resume, Esc = leave slideshow → PhotoPrism
 * UI, F = toggle browser fullscreen. Read-only: no photo mutation.
 */
export function bindFrameKeyboard(opts: FrameKeyboardOptions = {}): void {
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
      case 'f':
      case 'F':
        e.preventDefault();
        toggleFullscreen();
        break;
      case 'Escape':
        // Leave the slideshow and hand the frame to the PhotoPrism UI. Navigating
        // away unloads this page, so the slideshow stops rendering here; the server
        // engine stays authoritative and simply resumes if the frame returns.
        e.preventDefault();
        window.location.assign(resolvePhotoprismUrl(opts, window.location));
        break;
      default:
        break;
    }
  });

  // Escape slideshow to PhotoPrism UI on double right-click
  let lastRightClick = 0;
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const now = Date.now();
    if (now - lastRightClick < 500) {
      window.location.assign(resolvePhotoprismUrl(opts, window.location));
    }
    lastRightClick = now;
  });

  // Toggle fullscreen on double middle-click
  let lastMiddleClick = 0;
  window.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return; // only middle mouse button
    e.preventDefault();
    const now = Date.now();
    if (now - lastMiddleClick < 600) {
      lastMiddleClick = 0;
      toggleFullscreen();
    } else {
      lastMiddleClick = now;
    }
  });
}

