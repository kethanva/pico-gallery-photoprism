import { describe, it, expect, vi } from "vitest";
import PLightbox from "component/lightbox.vue";

// The kiosk boots fullscreen and "select a photo to resume" both funnel through
// $lightbox.openModels(models, index, collection, autoplay=true). The autoplay
// request is deferred as a flag (openLightbox → _autoplayOnOpen) and consumed
// once PhotoSwipe has initialized (onLightboxOpened, pswp afterInit) → into
// enterFullscreenSlideshow(). These tests pin every hop of that chain so a
// regression that silently drops the fullscreen slideshow is caught here rather
// than only on the frame. See lightbox.vue openLightbox / onLightboxOpened /
// enterFullscreenSlideshow / playSlideshow.
const M = PLightbox.methods;

describe("PLightbox — kiosk autoplay → fullscreen slideshow chain", () => {
  it("openLightbox(autoplay:true) arms the deferred autoplay flag", () => {
    const ctx = { showThumbs: vi.fn(), showView: vi.fn() };

    M.openLightbox.call(ctx, "lightbox.open", { models: [{}], index: 0, autoplay: true });

    expect(ctx.showThumbs).toHaveBeenCalledTimes(1);
    expect(ctx._autoplayOnOpen).toBe(true);
  });

  it("openLightbox(autoplay:false) leaves autoplay disarmed (normal browse open)", () => {
    const ctx = { showThumbs: vi.fn(), showView: vi.fn() };

    M.openLightbox.call(ctx, "lightbox.open", { models: [{}], index: 0, autoplay: false });

    expect(ctx._autoplayOnOpen).toBeFalsy();
  });

  it("onLightboxOpened consumes the armed flag and enters the fullscreen slideshow", () => {
    const ctx = {
      _autoplayOnOpen: true,
      addEventListeners: vi.fn(),
      wrapPswpNavGuards: vi.fn(),
      enterFullscreenSlideshow: vi.fn(),
      $event: { publish: vi.fn() },
    };

    M.onLightboxOpened.call(ctx);

    expect(ctx.enterFullscreenSlideshow).toHaveBeenCalledTimes(1);
    expect(ctx._autoplayOnOpen).toBe(false); // consumed once, never re-fires
    expect(ctx.$event.publish).toHaveBeenCalledWith("lightbox.opened");
  });

  it("onLightboxOpened without the flag does NOT force fullscreen", () => {
    const ctx = {
      _autoplayOnOpen: false,
      addEventListeners: vi.fn(),
      wrapPswpNavGuards: vi.fn(),
      enterFullscreenSlideshow: vi.fn(),
      $event: { publish: vi.fn() },
    };

    M.onLightboxOpened.call(ctx);

    expect(ctx.enterFullscreenSlideshow).not.toHaveBeenCalled();
  });

  it("enterFullscreenSlideshow starts playback AND requests fullscreen together", () => {
    const ctx = {
      playSlideshow: vi.fn(),
      requestFullscreen: vi.fn(() => Promise.resolve()),
    };

    M.enterFullscreenSlideshow.call(ctx);

    expect(ctx.playSlideshow).toHaveBeenCalledTimes(1);
    expect(ctx.requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("enterFullscreenSlideshow still plays even when requestFullscreen rejects (no native API)", () => {
    const ctx = {
      playSlideshow: vi.fn(),
      requestFullscreen: vi.fn(() => Promise.reject(new Error("no fullscreen API"))),
    };

    expect(() => M.enterFullscreenSlideshow.call(ctx)).not.toThrow();
    expect(ctx.playSlideshow).toHaveBeenCalledTimes(1);
  });

  it("playSlideshow marks the slideshow active, syncs next, and schedules advance", () => {
    const ctx = {
      slideshow: { active: false, interval: false, next: -1, wait: 5000 },
      index: 3,
      hideControls: vi.fn(),
      getContent: vi.fn(() => ({})),
      setSlideshowInterval: vi.fn(),
    };

    M.playSlideshow.call(ctx);

    expect(ctx.slideshow.active).toBe(true);
    expect(ctx.slideshow.next).toBe(3);
    expect(ctx.hideControls).toHaveBeenCalled();
    expect(ctx.setSlideshowInterval).toHaveBeenCalledTimes(1);
  });
});
