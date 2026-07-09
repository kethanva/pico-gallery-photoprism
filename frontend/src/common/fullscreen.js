// Utility class to detect, request, and exit fullscreen mode.
class Fullscreen {
  constructor() {
    // WPE WebKit in the Cog kiosk often lacks a working Fullscreen API; keep a
    // CSS fallback so F / double-right-click still hide chrome and fill the frame.
    this.virtual = false;
    // Native fullscreen on WPE/Cog breaks mouse/keyboard on overlay controls.
    this.virtualOnly = false;
  }

  setVirtualOnly(enabled) {
    this.virtualOnly = !!enabled;
  }

  // Returns true if the browser supports the fullscreen API.
  isSupported() {
    // see https://developer.mozilla.org/en-US/docs/Web/API/Document/fullscreenEnabled
    return !!document.fullscreenEnabled || !!document.webkitFullscreenEnabled;
  }

  // Returns true if fullscreen mode is enabled.
  isEnabled() {
    // see https://developer.mozilla.org/en-US/docs/Web/API/Document/fullscreenElement
    return (
      this.virtual ||
      !!document.fullscreenElement ||
      !!document.mozFullScreenElement ||
      !!document.webkitFullscreenElement
    );
  }

  setVirtual(enabled) {
    this.virtual = !!enabled;
    document.documentElement.classList.toggle("is-virtual-fullscreen", this.virtual);
  }

  // Toggles fullscreen mode and returns a Promise.
  toggle() {
    if (this.isEnabled()) {
      return this.exit();
    }
    return this.request();
  }

  // Requests to enter fullscreen mode if not already enabled and returns a Promise.
  request() {
    if (this.isEnabled()) {
      return Promise.resolve();
    }

    this.setVirtual(true);

    if (this.virtualOnly) {
      return Promise.resolve();
    }

    // see https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen
    if (typeof document.documentElement.requestFullscreen === "function") {
      return document.documentElement.requestFullscreen({ navigationUI: "hide" }).catch(() => Promise.resolve());
    }
    if (typeof document.documentElement.webkitRequestFullscreen === "function") {
      return document.documentElement.webkitRequestFullscreen().catch(() => Promise.resolve());
    }

    return Promise.resolve();
  }

  // Exits fullscreen mode if enabled and returns a Promise.
  exit() {
    this.setVirtual(false);

    if (this.virtualOnly) {
      return Promise.resolve();
    }

    if (!document.fullscreenElement && !document.mozFullScreenElement && !document.webkitFullscreenElement) {
      return Promise.resolve();
    }

    // see https://developer.mozilla.org/en-US/docs/Web/API/Document/exitFullscreen
    if (typeof document.exitFullscreen === "function") {
      return document.exitFullscreen().catch(() => Promise.resolve());
    }
    if (typeof document.webkitExitFullscreen === "function") {
      return document.webkitExitFullscreen().catch(() => Promise.resolve());
    }

    return Promise.resolve();
  }
}

const $fullscreen = new Fullscreen();

export default $fullscreen;
