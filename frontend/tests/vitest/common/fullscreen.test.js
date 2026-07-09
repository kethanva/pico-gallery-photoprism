import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import $fullscreen from "../../../src/common/fullscreen.js";

describe("fullscreen utility", () => {
  beforeEach(async () => {
    await $fullscreen.exit();
    $fullscreen.setVirtualOnly(false);
  });

  afterEach(async () => {
    await $fullscreen.exit();
    $fullscreen.setVirtualOnly(false);
  });

  it("uses virtual fullscreen without calling native APIs when virtualOnly is set", async () => {
    document.documentElement.requestFullscreen = vi.fn(() => Promise.resolve());
    $fullscreen.setVirtualOnly(true);

    await $fullscreen.request();

    expect($fullscreen.isEnabled()).toBe(true);
    expect(document.documentElement.classList.contains("is-virtual-fullscreen")).toBe(true);
    expect(document.documentElement.requestFullscreen).not.toHaveBeenCalled();
    delete document.documentElement.requestFullscreen;
  });

  it("clears virtual fullscreen on exit when virtualOnly is set", async () => {
    $fullscreen.setVirtualOnly(true);
    await $fullscreen.request();
    await $fullscreen.exit();

    expect($fullscreen.isEnabled()).toBe(false);
    expect(document.documentElement.classList.contains("is-virtual-fullscreen")).toBe(false);
  });
});
