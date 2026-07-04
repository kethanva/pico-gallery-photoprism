import { describe, it, expect } from "vitest";
import Photos from "page/photos.vue";
import AlbumPhotos from "page/album/photos.vue";

// The appliance frame is a locked, photos-only surface: /library/photos?kiosk=true
// (and album kiosks) must NOT render the PhotoPrism chrome — the left nav rail
// (app.vue, v-if="!kioskMode") and the search/view toolbar (v-if="!kioskMode" on
// each page). These pin the kioskMode computed that drives that hiding so a
// regression can't silently bring the chrome back on the frame.
const call = (component, ctx) => component.computed.kioskMode.call(ctx);
const withQuery = (query) => ({ $route: { query } });

describe.each([
  ["page/photos.vue", Photos],
  ["page/album/photos.vue", AlbumPhotos],
])("%s — kioskMode", (_name, component) => {
  it("is true when ?kiosk is present", () => {
    expect(call(component, withQuery({ kiosk: "true" }))).toBe(true);
  });

  it("is true when ?slideshow is present", () => {
    expect(call(component, withQuery({ slideshow: "true" }))).toBe(true);
  });

  it("is false for a normal browse route (chrome stays visible)", () => {
    expect(call(component, withQuery({}))).toBe(false);
    expect(call(component, withQuery({ q: "cats" }))).toBe(false);
  });

  it("returns a real boolean, never a raw query string", () => {
    expect(call(component, withQuery({ kiosk: "true" }))).toStrictEqual(true);
  });
});
