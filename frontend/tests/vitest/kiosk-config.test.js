import { describe, it, expect } from "vitest";
import { resolveKioskConfig } from "../../src/kiosk-config.js";

describe("kiosk-config", () => {
  it("defaults to pi_zero_2 profile with safe sizes", () => {
    const cfg = resolveKioskConfig({});
    expect(cfg.profile).toBe("pi_zero_2");
    expect(cfg.previewSize).toBe("fit_720");
    expect(cfg.thumbSize).toBe("fit_720");
    expect(cfg.maxGridRows).toBe(10);
    expect(cfg.firstPageSize).toBe(16);
    expect(cfg.thumbLoadConcurrency).toBe(4);
  });

  it("clamps unsafe overrides instead of breaking the UI", () => {
    const cfg = resolveKioskConfig({
      profile: "quality",
      previewSize: "fit_9999",
      maxGridRows: 999,
      backgroundFillTarget: -5,
      firstPageSize: 1,
    });
    expect(cfg.profile).toBe("quality");
    expect(cfg.previewSize).toBe("fit_1280");
    expect(cfg.maxGridRows).toBe(24);
    expect(cfg.backgroundFillTarget).toBe(0);
    expect(cfg.firstPageSize).toBe(4);
  });

  it("allows disabling slideshow background prefetch", () => {
    const cfg = resolveKioskConfig({ backgroundFillTarget: 0 });
    expect(cfg.backgroundFillTarget).toBe(0);
  });
});
