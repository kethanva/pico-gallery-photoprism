import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bootMinimalPhotoApp, mapPhoto, pickHash } from "../../src/minimal-photo-app.js";

const fullscreenMock = vi.hoisted(() => ({
  isEnabled: vi.fn(() => false),
  request: vi.fn(() => Promise.resolve()),
  exit: vi.fn(() => Promise.resolve()),
  toggle: vi.fn(() => Promise.resolve()),
  setVirtualOnly: vi.fn(),
}));

vi.mock("common/fullscreen", () => ({
  default: fullscreenMock,
}));

const samplePhoto = {
  UID: "abc123",
  Title: "Sunset",
  Hash: "deadbeef",
};

describe("minimal-photo-app helpers", () => {
  it("pickHash prefers top-level Hash", () => {
    expect(pickHash(samplePhoto)).toBe("deadbeef");
  });

  it("pickHash falls back to primary file hash", () => {
    expect(
      pickHash({
        Files: [
          { Hash: "aaa", Primary: false },
          { Hash: "bbb", Primary: true },
        ],
      })
    ).toBe("bbb");
  });

  it("mapPhoto builds thumbnail and preview URLs", () => {
    window.__CONFIG__ = {
      staticUri: "/static",
      contentUri: "/api/v1",
      previewToken: "public",
    };
    const photo = mapPhoto(samplePhoto);
    expect(photo.title).toBe("Sunset");
    expect(photo.thumbSrc).toBe("/api/v1/t/deadbeef/public/fit_720");
    expect(photo.fullSrc).toBe("/api/v1/t/deadbeef/public/fit_1280");
  });
});

function mockFetch(handler) {
  return vi.fn(async (url) => {
    const pathname = new URL(url, "http://localhost").pathname;
    if (pathname.endsWith("/config")) {
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({ previewToken: "public" }),
      };
    }
    return handler(url);
  });
}

function makePhoto(i) {
  return { UID: `p${i}`, Title: `Photo ${i}`, Hash: `hash${i}` };
}

function tapControl(node) {
  node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
  node.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0 }));
}

describe("minimal-photo-app boot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fullscreenMock.isEnabled.mockReturnValue(false);
    global.IntersectionObserver = class IntersectionObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    window.__CONFIG__ = {
      apiUri: "/api/v1",
      contentUri: "/api/v1",
      staticUri: "/static",
      previewToken: "public",
      kioskConfig: { slideDuration: 5 },
    };
    document.body.innerHTML = '<div id="app"></div>';
    vi.stubGlobal(
      "fetch",
      mockFetch(async (url) => {
        const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") || 0);
        if (offset > 0) {
          return {
            ok: true,
            headers: { get: () => null },
            json: async () => [],
          };
        }
        return {
          ok: true,
          headers: { get: () => null },
          json: async () => [makePhoto(1), makePhoto(2)],
        };
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("renders photo cards after fetch", async () => {
    await bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".pg-card").length).toBe(2);
    });
    expect(document.querySelector(".pg-title")?.textContent).toBe("Photos");
  });

  it("opens preview from thumbnail click", async () => {
    await bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelectorAll(".pg-card").length === 2);
    document.querySelector(".pg-card")?.click();
    await vi.waitFor(() => document.querySelector(".pg-overlay.is-open"));
    expect(document.querySelector(".pg-overlay-counter")?.textContent).toContain("1 / 2");
  });

  it("places top sentinel inside the grid after the spacer", async () => {
    await bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelector(".pg-grid"));
    const grid = document.querySelector(".pg-grid");
    const spacer = grid?.querySelector(".pg-top-spacer");
    const sentinel = grid?.querySelector(".pg-top-sentinel");
    expect(spacer).toBeTruthy();
    expect(sentinel).toBeTruthy();
    expect(spacer?.nextElementSibling).toBe(sentinel);
  });

  it("auto-advances preview after loading more at end of list", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(async (url) => {
        const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") || 0);
        if (offset === 0) {
          return {
            ok: true,
            headers: { get: () => null },
            json: async () => [makePhoto(1)],
          };
        }
        return {
          ok: true,
          headers: { get: () => null },
          json: async () => [makePhoto(2)],
        };
      })
    );

    await bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelectorAll(".pg-card").length === 1);
    document.querySelector(".pg-card")?.click();
    await vi.waitFor(() => document.querySelector(".pg-overlay.is-open"));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await vi.waitFor(() => document.querySelector(".pg-preview")?.getAttribute("src")?.includes("hash2"));
  });

  it("toggles slideshow mode from header button", async () => {
    await bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelectorAll(".pg-card").length === 2);

    document.querySelector(".pg-slideshow")?.click();
    await vi.waitFor(() => document.querySelector(".pg-slideshow.is-active"));
    await vi.waitFor(() => document.querySelector(".pg-overlay.is-open"));

    document.querySelector(".pg-slideshow")?.click();
    await vi.waitFor(() => !document.querySelector(".pg-overlay.is-open"));
    expect(document.querySelector(".pg-slideshow.is-active")).toBeFalsy();
    expect(fullscreenMock.exit).toHaveBeenCalled();
  });

  it("toggles slideshow with S key", async () => {
    await bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelectorAll(".pg-card").length === 2);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true }));
    await vi.waitFor(() => document.querySelector(".pg-overlay.is-open"));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "S", bubbles: true, cancelable: true }));
    await vi.waitFor(() => !document.querySelector(".pg-overlay.is-open"));
  });

  it("places overlay on document.body outside the app shell", async () => {
    await bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelector(".pg-overlay"));
    const overlay = document.querySelector(".pg-overlay");
    expect(overlay?.parentElement).toBe(document.body);
    expect(document.getElementById("app")?.contains(overlay)).toBe(false);
  });

  it("enables virtual-only fullscreen for kiosk boot", async () => {
    await bootMinimalPhotoApp(document.getElementById("app"));
    expect(fullscreenMock.setVirtualOnly).toHaveBeenCalledWith(true);
  });

  it("places overlay controls in a chrome layer above the preview", async () => {
    await bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelector(".pg-overlay-chrome"));
    expect(document.querySelector(".pg-overlay-chrome .pg-close")).toBeTruthy();
  });

  it("auto-starts slideshow on kiosk boot when configured", async () => {
    window.__CONFIG__.kioskConfig = { slideDuration: 5, autoSlideshow: true };
    await bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelector(".pg-slideshow.is-active"));
    expect(document.querySelector(".pg-overlay.is-open")).toBeTruthy();
  });

  it("exits fullscreen when closing preview", async () => {
    await bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelectorAll(".pg-card").length === 2);
    document.querySelector(".pg-card")?.click();
    await vi.waitFor(() => document.querySelector(".pg-overlay.is-open"));

    const closeBtn = document.querySelector(".pg-close");
    tapControl(closeBtn);
    await vi.waitFor(() => !document.querySelector(".pg-overlay.is-open"));
    expect(fullscreenMock.exit).toHaveBeenCalled();
  });

  it("closes preview with Escape via capture-phase keydown", async () => {
    await bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelectorAll(".pg-card").length === 2);
    document.querySelector(".pg-card")?.click();
    await vi.waitFor(() => document.querySelector(".pg-overlay.is-open"));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await vi.waitFor(() => !document.querySelector(".pg-overlay.is-open"));
    expect(fullscreenMock.exit).toHaveBeenCalled();
  });

  it("navigates preview with arrow keys", async () => {
    await bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelectorAll(".pg-card").length === 2);
    document.querySelector(".pg-card")?.click();
    await vi.waitFor(() => document.querySelector(".pg-overlay.is-open"));
    expect(document.querySelector(".pg-overlay-counter")?.textContent).toContain("1 / 2");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await vi.waitFor(() => document.querySelector(".pg-overlay-counter")?.textContent?.includes("2 / 2"));
  });

  it("toggles fullscreen with F while preview is open", async () => {
    await bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelectorAll(".pg-card").length === 2);
    document.querySelector(".pg-card")?.click();
    await vi.waitFor(() => document.querySelector(".pg-overlay.is-open"));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true }));
    expect(fullscreenMock.toggle).toHaveBeenCalled();
  });

  it("re-arms scroll observers after Reload", async () => {
    let instances = 0;
    const observedNodes = [];
    global.IntersectionObserver = class {
      constructor() {
        instances += 1;
      }
      observe(node) {
        observedNodes.push(node);
      }
      unobserve() {}
      disconnect() {}
    };

    await bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelectorAll(".pg-card").length === 2);
    expect(instances).toBe(2);

    const reloadBtn = [...document.querySelectorAll(".pg-button")].find((b) => b.textContent === "Reload");
    reloadBtn?.click();
    await vi.waitFor(() => instances === 4);
    // The bottom sentinel is observed again by a fresh observer.
    const sentinel = document.querySelector(".pg-sentinel");
    expect(observedNodes.filter((n) => n === sentinel).length).toBe(2);
  });

  it("prefetches additional pages only while slideshow is active", async () => {
    vi.useFakeTimers();
    window.__CONFIG__.kioskConfig = { slideDuration: 5, autoSlideshow: true };
    const fetchMock = mockFetch(async (url) => {
      const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") || 0);
      const count = Number(new URL(url, "http://localhost").searchParams.get("count") || 12);
      const batch = Array.from({ length: count }, (_, i) => makePhoto(offset + i + 1));
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => batch,
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const bootPromise = bootMinimalPhotoApp(document.getElementById("app"));
    await vi.runOnlyPendingTimersAsync();
    await bootPromise;

    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/photos")).length).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/photos")).length >= 2);
  });

  it("does not background-prefetch on grid-only boot", async () => {
    vi.useFakeTimers();
    window.__CONFIG__.kioskConfig = { slideDuration: 5, autoSlideshow: false };
    const fetchMock = mockFetch(async (url) => {
      const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") || 0);
      if (offset > 0) {
        return { ok: true, headers: { get: () => null }, json: async () => [] };
      }
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => [makePhoto(1), makePhoto(2)],
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const bootPromise = bootMinimalPhotoApp(document.getElementById("app"));
    await vi.runOnlyPendingTimersAsync();
    await bootPromise;
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("/photos")).length).toBe(1);
  });
});
