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
 * Left/Right = prev/next, Space = pause/resume. F, Esc, or double right-click =
 * hand the frame to the PhotoPrism UI (the same gestures there hand it back, so
 * they act as a surface toggle). Double middle-click = browser fullscreen.
 * Read-only: no photo mutation.
 */
export function bindFrameKeyboard(opts: FrameKeyboardOptions = {}): void {
  // Toggle to the other surface. Navigating away unloads this page, so the
  // slideshow stops rendering here; the server engine stays authoritative and
  // simply resumes when the frame returns (via F/double-right-click over there).
  const gotoPhotoprism = (): void => {
    window.location.assign(resolvePhotoprismUrl(opts, window.location));
  };

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
      case 'Escape':
        e.preventDefault();
        gotoPhotoprism();
        break;
      default:
        break;
    }
  });

  // Handle left click: left 30% = prev, right 30% = next, center = pause/resume
  window.addEventListener('click', (e) => {
    if (e.button !== 0) return; // only left click
    const x = e.clientX;
    const width = window.innerWidth;
    if (x <= width * 0.3) {
      e.preventDefault();
      void api.control({ action: 'prev' });
    } else if (x >= width * 0.7) {
      e.preventDefault();
      void api.control({ action: 'next' });
    } else {
      e.preventDefault();
      void api.control({ action: 'toggle_pause' });
    }
  });

  // Toggle to the PhotoPrism UI on right-click (mouse mirror of F/Esc).
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    gotoPhotoprism();
  });

  // Toggle fullscreen on middle-click
  window.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return; // only middle mouse button
    e.preventDefault();
    toggleFullscreen();
  });
}

