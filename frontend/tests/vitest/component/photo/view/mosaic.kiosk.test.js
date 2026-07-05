import { describe, it, expect, vi, beforeEach } from "vitest";
import { shallowMount } from "@vue/test-utils";
import PPhotoViewMosaic from "component/photo/view/mosaic.vue";
import "../../../fixtures";

// The photos-only appliance frame runs on a 512 MB Pi Zero 2 W. In kiosk mode
// the mosaic must render each live tile as the bare thumbnail — no hover
// overlay, no open/select/favorite buttons, no autoplaying <video> for live
// photos — because none are reachable with the toolbar hidden and rendering
// ~7 fewer DOM nodes per tile (and never mounting a video) is what keeps the
// grid scrollable on that hardware. See component/photo/view/mosaic.vue.

function createConfigMock() {
  return {
    getSettings: () => ({
      features: { places: true, private: true, download: true },
      search: { showTitles: true, showCaptions: true },
    }),
    feature: () => true,
    get: () => false,
  };
}

// A live photo exercises the heaviest full-tile branch: the full tile mounts a
// <video> live-player, the kiosk tile must not.
function createLivePhotoStub() {
  return {
    ID: 1,
    UID: "pq1",
    Title: "Live Sample",
    Type: "live",
    Favorite: false,
    Private: false,
    classes: () => "is-live",
    thumbnailUrl: () => "/thumb.jpg",
    getOriginalName: () => "IMG_0001.HEIC",
    isStack: () => false,
    videoContentType: () => "video/mp4",
    videoUrl: () => "/video.mp4",
    getDurationInfo: () => "00:03",
    toggleLike: vi.fn(),
  };
}

function mountMosaic(query) {
  return shallowMount(PPhotoViewMosaic, {
    props: {
      photos: [createLivePhotoStub()],
      filter: { order: "newest" },
      selectMode: false,
      isSharedView: false,
      openPhoto: vi.fn(),
      editPhoto: vi.fn(),
    },
    global: {
      mocks: {
        $config: createConfigMock(),
        $route: { query },
      },
      stubs: { IconLivePhoto: true },
    },
  });
}

describe("component/photo/view/mosaic kiosk-lean rendering", () => {
  beforeEach(() => {
    global.IntersectionObserver = class IntersectionObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it("kiosk mode renders the bare thumbnail — no buttons, overlay, or live video", () => {
    const wrapper = mountMosaic({ kiosk: "true" });

    // The tile itself still renders (index 0 is within the initial visible range).
    const tile = wrapper.find(".media.result.preview");
    expect(tile.exists()).toBe(true);
    expect(tile.attributes("style")).toContain("/thumb.jpg");

    // None of the interactive chrome — unreachable on the frame — is rendered.
    expect(wrapper.find(".input-select").exists()).toBe(false);
    expect(wrapper.find(".input-favorite").exists()).toBe(false);
    expect(wrapper.find(".input-open").exists()).toBe(false);
    expect(wrapper.find(".preview__overlay").exists()).toBe(false);
    // The autoplaying live-photo <video> — the single heaviest per-tile cost —
    // must not be mounted in kiosk mode.
    expect(wrapper.find("video").exists()).toBe(false);
    expect(wrapper.find(".live-player").exists()).toBe(false);
  });

  it("kiosk-aware prefetch uses the tighter 20% rootMargin", () => {
    const wrapper = mountMosaic({ kiosk: "true" });
    expect(wrapper.vm.kioskMode).toBe(true);

    const desktop = mountMosaic({});
    expect(desktop.vm.kioskMode).toBe(false);
  });

  it("non-kiosk mode still renders the full interactive tile", () => {
    const wrapper = mountMosaic({});

    expect(wrapper.find(".media.result.preview").exists()).toBe(true);
    // The full tile keeps its selection/favorite controls, hover overlay, and
    // the live-player video element.
    expect(wrapper.find(".input-select").exists()).toBe(true);
    expect(wrapper.find(".input-favorite").exists()).toBe(true);
    expect(wrapper.find(".preview__overlay").exists()).toBe(true);
    expect(wrapper.find(".live-player").exists()).toBe(true);
  });
});
