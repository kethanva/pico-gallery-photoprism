import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bootMinimalPhotoApp, mapPhoto, pickHash } from "../../src/minimal-photo-app.js";

vi.mock("common/fullscreen", () => ({
  default: {
    isEnabled: () => false,
    request: () => Promise.resolve(),
    exit: () => Promise.resolve(),
    toggle: () => Promise.resolve(),
  },
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
    expect(photo.thumbSrc).toBe("/api/v1/t/deadbeef/public/fit_360");
    expect(photo.fullSrc).toBe("/api/v1/t/deadbeef/public/fit_1280");
  });
});

describe("minimal-photo-app boot", () => {
  beforeEach(() => {
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
      vi.fn(async (url) => {
        const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") || 0);
        if (offset > 0) {
          return {
            ok: true,
            json: async () => [],
          };
        }
        return {
          ok: true,
          json: async () => [
            { UID: "p1", Title: "One", Hash: "hash1" },
            { UID: "p2", Title: "Two", Hash: "hash2" },
          ],
        };
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders photo cards after fetch", async () => {
    bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => {
      expect(document.querySelectorAll(".pg-card").length).toBe(2);
    });
    expect(document.querySelector(".pg-title")?.textContent).toBe("Photos");
  });

  it("opens preview from thumbnail click", async () => {
    bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelectorAll(".pg-card").length === 2);
    document.querySelector(".pg-card")?.click();
    await vi.waitFor(() => document.querySelector(".pg-overlay.is-open"));
  });

  it("places top sentinel inside the grid after the spacer", async () => {
    bootMinimalPhotoApp(document.getElementById("app"));
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
      vi.fn(async (url) => {
        const offset = Number(new URL(url, "http://localhost").searchParams.get("offset") || 0);
        if (offset === 0) {
          return {
            ok: true,
            json: async () => [{ UID: "p1", Title: "One", Hash: "hash1" }],
          };
        }
        return {
          ok: true,
          json: async () => [{ UID: "p2", Title: "Two", Hash: "hash2" }],
        };
      })
    );

    bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelectorAll(".pg-card").length === 1);
    document.querySelector(".pg-card")?.click();
    await vi.waitFor(() => document.querySelector(".pg-overlay.is-open"));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await vi.waitFor(() => document.querySelector(".pg-preview")?.getAttribute("src")?.includes("hash2"));
  });

  it("toggles slideshow mode from header button", async () => {
    bootMinimalPhotoApp(document.getElementById("app"));
    await vi.waitFor(() => document.querySelectorAll(".pg-card").length === 2);

    document.querySelector(".pg-slideshow")?.click();
    await vi.waitFor(() => document.querySelector(".pg-slideshow.is-active"));
    await vi.waitFor(() => document.querySelector(".pg-overlay.is-open"));
  });
});
