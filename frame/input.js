const DOUBLE_CLICK_MS = 400;

/**
 * Kiosk input: F / double right-click toggles surfaces; lone right-click pauses.
 * @param {{ onToggle: () => void, onPause: () => void, onNext: () => void, onPrev: () => void, onEscape: () => void }} handlers
 */
export function bindInput(handlers) {
  let lastCtx = 0;

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = /** @type {HTMLElement} */ (e.target);
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    switch (e.key) {
      case 'f':
      case 'F':
        e.preventDefault();
        handlers.onToggle();
        break;
      case 'ArrowRight':
        e.preventDefault();
        handlers.onNext();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        handlers.onPrev();
        break;
      case ' ':
        e.preventDefault();
        handlers.onPause();
        break;
      case 'Escape':
        e.preventDefault();
        handlers.onEscape();
        break;
      default:
        break;
    }
  });

  // Middle-click toggles surfaces — same contract as F and double right-click
  // (the old kiosk honored middle-click; muscle memory expects it).
  document.addEventListener('auxclick', (e) => {
    if (e.button !== 1 || e.defaultPrevented) return;
    e.preventDefault();
    handlers.onToggle();
  });

  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastCtx <= DOUBLE_CLICK_MS) {
      lastCtx = 0;
      handlers.onToggle();
    } else {
      lastCtx = now;
      handlers.onPause();
    }
  });
}
