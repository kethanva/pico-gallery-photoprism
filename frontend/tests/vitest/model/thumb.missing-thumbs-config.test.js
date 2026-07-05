import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Thumb from "model/thumb";
import Photo from "model/photo";
import { $config } from "app/session.js";

// Regression guard for the kiosk "blank on boot / dead clicks" bug.
//
// Thumb read its size list from window.__CONFIG__.thumbs at module load. The
// appliance's static index.html shell does NOT populate that field (only the
// backend's /api/v1/config does, loaded later into $config), so `thumbs` was
// undefined and `fromPhoto()` threw "Cannot read properties of undefined
// (reading 'length')" on the FIRST Thumb.fromPhotos() call — i.e. the kiosk boot
// slideshow and every tap-to-open-a-photo. The grid rendered; the lightbox never
// opened. The test suite missed it because its window.__CONFIG__ (clientConfig)
// DOES carry thumbs. These tests drop the thumbs config to reproduce the frame.
describe("Thumb — resilient when the thumbs size config is absent", () => {
  let savedThumbs;

  beforeEach(() => {
    savedThumbs = $config.get("thumbs");
  });

  afterEach(() => {
    $config.values.thumbs = savedThumbs;
  });

  const clearThumbs = () => {
    $config.values.thumbs = undefined;
  };

  it("fromPhotos does not throw when $config has no thumbs (the frame's boot slideshow path)", () => {
    clearThumbs();
    const photos = [new Photo({ UID: "pqrst000001", Hash: "abc123def456", Type: "image", Width: 800, Height: 600 })];

    expect(() => Thumb.fromPhotos(photos)).not.toThrow();

    const out = Thumb.fromPhotos(photos);
    expect(out).toHaveLength(1);
    expect(out[0].UID).toBe("pqrst000001");
    expect(out[0].Thumbs).toEqual({}); // no sizes configured → empty, not a crash
  });

  it("fromPhoto does not throw for a Files-backed photo when thumbs are absent", () => {
    clearThumbs();
    const photo = new Photo({
      UID: "pqrst000002",
      Hash: "hash2",
      Type: "image",
      Files: [{ UID: "f2", Name: "a.jpg", Primary: true, FileType: "jpg", Width: 500, Height: 600, Hash: "fh2" }],
    });

    expect(() => Thumb.fromPhoto(photo)).not.toThrow();
  });

  it("reads the LIVE $config size list, not the static window.__CONFIG__ snapshot", () => {
    // Uses a size name the test fixture's window.__CONFIG__.thumbs does NOT
    // contain, so this only passes if fromPhoto() reads $config at call-time
    // (the fix) rather than the module-load snapshot of window.__CONFIG__.
    $config.values.thumbs = [{ size: "fit_probe_9999", w: 999, h: 999 }];
    const photo = new Photo({ UID: "pqrst000003", Hash: "hash3", Type: "image", Width: 1000, Height: 800 });
    const t = Thumb.fromPhoto(photo);
    expect(t.Thumbs).toHaveProperty("fit_probe_9999");
    expect(t.Thumbs).not.toHaveProperty("fit_720"); // the static fixture's sizes must NOT leak in
  });
});
