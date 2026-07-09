import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bootMinimalPhotoApp, mapPhoto, pickHash } from "../../src/minimal-photo-app.js";

const fullscreenMock = vi.hoisted(() => ({
  isEnabled: vi.fn(() => false),
  request: vi.fn(() => Promise.resolve()),
  exit: vi.fn(() => Promise.resolve()),
  toggle: vi.fn(() => Promise.resolve()),
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

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await vi.waitFor(() => document.querySelector(".pg-preview")?.getAttribute("src")?.includes("hash2"));
  });

  it("toggles slideshow mode from header button", async () => {
    await bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelectorAll(".pg-card").length === 2);

    document.querySelector(".pg-slideshow")?.click();
    await vi.waitFor(() => document.querySelector(".pg-slideshow.is-active"));
    await vi.waitFor(() => document.querySelector(".pg-overlay.is-open"));
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

    document.querySelector(".pg-close")?.click();
    await vi.waitFor(() => !document.querySelector(".pg-overlay.is-open"));
    expect(fullscreenMock.exit).toHaveBeenCalled();
  });

  it("toggles fullscreen with F while preview is open", async () => {
    await bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelectorAll(".pg-card").length === 2);
    document.querySelector(".pg-card")?.click();
    await vi.waitFor(() => document.querySelector(".pg-overlay.is-open"));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f" }));
    expect(fullscreenMock.toggle).toHaveBeenCalled();
  });

  it("prefetches additional pages in the background", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch(async (url) => {
      const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") || 0);
      const count = Number(new URL(url, "http://localhost").searchParams.get("count") || 16);
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

    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => fetchMock.mock.calls.filter((c) => String(c[0]).includes("/photos")).length >= 2);
  });
});
