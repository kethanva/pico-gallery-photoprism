// Pins the click classification in common/input.js, with emphasis on the
// zero-duration case that broke single clicks on the Pi frame.
//
// WebKit (WPE WebKit under Cage) reports integer-millisecond event timeStamps,
// so a quick physical mousedown+click lands in the SAME millisecond and
// clickDuration is exactly 0. The evaluator must treat that as a short click,
// not InputInvalid — otherwise fullscreen-open and select/highlight silently
// do nothing on the appliance. Reproduced with Playwright WebKit before the fix.
import { describe, it, expect } from "vitest";

import { Input, InputInvalid, ClickShort, ClickLong } from "common/input";

// evClick builds a minimal MouseEvent-like object for clickType(): only
// timeStamp is read for mouse (non-touch) clicks.
const evAt = (timeStamp) => ({ timeStamp });

describe("common/input.js", () => {
  describe("Input.eval — mouse click classification", () => {
    it("classifies a zero-duration click as a short click (WebKit same-millisecond)", () => {
      const input = new Input();
      input.mouseDown(evAt(1000), 3);
      // click event carries the identical integer-ms timeStamp as mousedown
      expect(input.eval(evAt(1000), 3)).toBe(ClickShort);
    });

    it("classifies a fast sub-333ms click as a short click", () => {
      const input = new Input();
      input.mouseDown(evAt(1000), 0);
      expect(input.eval(evAt(1050), 0)).toBe(ClickShort);
    });

    it("classifies a >=333ms hold as a long click", () => {
      const input = new Input();
      input.mouseDown(evAt(1000), 0);
      expect(input.eval(evAt(1400), 0)).toBe(ClickLong);
    });

    it("classifies exactly 333ms as a long click (boundary)", () => {
      const input = new Input();
      input.mouseDown(evAt(1000), 0);
      expect(input.eval(evAt(1333), 0)).toBe(ClickLong);
    });

    it("returns InputInvalid for a negative duration (click timeStamp before mousedown)", () => {
      const input = new Input();
      input.mouseDown(evAt(2000), 0);
      // Clock weirdness / stale event: must not classify as any click.
      expect(input.eval(evAt(1000), 0)).toBe(InputInvalid);
    });

    it("returns InputInvalid when there was no preceding mousedown (programmatic/keyboard click)", () => {
      const input = new Input();
      // No mouseDown → timeStamp stays -1 after construction/reset.
      expect(input.eval(evAt(1000), 0)).toBe(InputInvalid);
    });

    it("returns InputInvalid when the click lands on a different index than the mousedown", () => {
      const input = new Input();
      input.mouseDown(evAt(1000), 2);
      expect(input.eval(evAt(1000), 5)).toBe(InputInvalid);
    });

    it("returns InputInvalid when the page scrolled between mousedown and click", () => {
      const input = new Input();
      const originalScrollY = window.scrollY;
      try {
        Object.defineProperty(window, "scrollY", { value: 100, configurable: true, writable: true });
        input.mouseDown(evAt(1000), 0);
        // Scroll moved before the click landed — must not register as a click.
        window.scrollY = 250;
        expect(input.eval(evAt(1050), 0)).toBe(InputInvalid);
      } finally {
        Object.defineProperty(window, "scrollY", { value: originalScrollY, configurable: true, writable: true });
      }
    });

    it("resets after each eval so a second bare click is InputInvalid", () => {
      const input = new Input();
      input.mouseDown(evAt(1000), 0);
      expect(input.eval(evAt(1000), 0)).toBe(ClickShort);
      // Second click with no fresh mousedown must not register.
      expect(input.eval(evAt(1001), 0)).toBe(InputInvalid);
    });

    it("ignores mousedown on a touch-preferring device (preferTouch stays set)", () => {
      const input = new Input();
      input.touchStart({ touches: [], timeStamp: 1000 }, 0);
      // A stray mousedown must not overwrite touch state on a touch device.
      input.mouseDown(evAt(2000), 0);
      // The synthesized mouse click after touch has no changedTouches; index/scroll
      // match and the recorded touch timeStamp is 1000, so a 0-ish duration click
      // still resolves as a short click rather than being dropped.
      expect(input.eval(evAt(1000), 0)).toBe(ClickShort);
    });
  });

  describe("Input.eval — touch tap classification", () => {
    // evTouchStart/evTouchEnd model the touch pair clickType() reads:
    // touchStart records ev.touches; the ending click carries ev.changedTouches.
    const evTouchStart = (timeStamp, x, y) => ({ timeStamp, touches: [{ screenX: x, screenY: y }] });
    const evTouchEnd = (timeStamp, x, y) => ({ timeStamp, changedTouches: [{ screenX: x, screenY: y }] });

    it("classifies a quick stationary tap as a short click", () => {
      const input = new Input();
      input.touchStart(evTouchStart(1000, 50, 80), 0);
      expect(input.eval(evTouchEnd(1050, 52, 81), 0)).toBe(ClickShort);
    });

    it("classifies a zero-duration tap as a short click (WebKit same-millisecond)", () => {
      const input = new Input();
      input.touchStart(evTouchStart(1000, 50, 80), 0);
      expect(input.eval(evTouchEnd(1000, 50, 80), 0)).toBe(ClickShort);
    });

    it("returns InputInvalid when the finger moved more than 4px (swipe, not tap)", () => {
      const input = new Input();
      input.touchStart(evTouchStart(1000, 50, 80), 0);
      expect(input.eval(evTouchEnd(1050, 60, 80), 0)).toBe(InputInvalid);
    });

    it("returns InputInvalid for a multi-touch start ending in a single changedTouch", () => {
      const input = new Input();
      input.touchStart(
        {
          timeStamp: 1000,
          touches: [
            { screenX: 50, screenY: 80 },
            { screenX: 90, screenY: 80 },
          ],
        },
        0
      );
      expect(input.eval(evTouchEnd(1050, 50, 80), 0)).toBe(InputInvalid);
    });
  });
});
