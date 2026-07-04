import { describe, it, expect, vi, afterEach } from "vitest";
import PLightbox from "component/lightbox.vue";

// The appliance surface toggle (leave the immersive slideshow → PhotoPrism grid)
// is wired with DOCUMENT-LEVEL capture listeners attached in afterEnter and
// removed in afterLeave, NOT via template @keydown bindings — during an
// autoplaying slideshow the controls are hidden and focus sits on document.body,
// so a component-scoped @keydown.f would never fire. These tests pin that
// contract: plain F and double right-click close the lightbox, the guards hold,
// and afterLeave fully detaches so the grid-side (host-injected) handlers regain
// ownership. See lightbox.vue afterEnter/afterLeave.
const { afterEnter, afterLeave } = PLightbox.methods;

// Minimal stand-in for the component instance the two lifecycle hooks touch.
const makeCtx = () => ({
  $event: { publish: vi.fn() },
  $view: { leave: vi.fn() },
  $emit: vi.fn(),
  close: vi.fn(),
  toggleFullscreen: vi.fn(),
  visible: true,
  busy: false,
  closing: false,
});

const fire = (type, target, init = {}) => {
  const ev =
    type === "keydown"
      ? new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
      : new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
};

describe("PLightbox — appliance surface toggle (document-level F / right-click)", () => {
  let ctx;

  afterEach(() => {
    // Always detach so a failed assertion cannot leak module-level listeners
    // into the next test (afterLeave is idempotent when nothing is attached).
    if (ctx) {
      afterLeave.call(ctx);
      ctx = null;
    }
  });

  it("plain F closes the lightbox and swallows the event", () => {
    ctx = makeCtx();
    afterEnter.call(ctx);

    const ev = fire("keydown", document, { key: "f" });

    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("uppercase F (shift) also closes", () => {
    ctx = makeCtx();
    afterEnter.call(ctx);

    fire("keydown", document, { key: "F" });

    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it("F with a modifier is ignored (Ctrl/⌘+F stays a real shortcut)", () => {
    ctx = makeCtx();
    afterEnter.call(ctx);

    fire("keydown", document, { key: "f", ctrlKey: true });
    fire("keydown", document, { key: "f", metaKey: true });
    fire("keydown", document, { key: "f", altKey: true });

    expect(ctx.close).not.toHaveBeenCalled();
  });

  it("F typed into an input/textarea is ignored", () => {
    ctx = makeCtx();
    afterEnter.call(ctx);

    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    document.body.append(input, textarea);
    try {
      fire("keydown", input, { key: "f" });
      fire("keydown", textarea, { key: "f" });
      expect(ctx.close).not.toHaveBeenCalled();
    } finally {
      input.remove();
      textarea.remove();
    }
  });

  it("a non-F key does not close", () => {
    ctx = makeCtx();
    afterEnter.call(ctx);

    fire("keydown", document, { key: "g" });

    expect(ctx.close).not.toHaveBeenCalled();
  });

  it("a lone right-click only suppresses the menu; it does not close", () => {
    ctx = makeCtx();
    afterEnter.call(ctx);

    const ev = fire("contextmenu", document);

    expect(ctx.close).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true); // browser menu suppressed
  });

  it("double right-click within the window closes", () => {
    ctx = makeCtx();
    afterEnter.call(ctx);

    fire("contextmenu", document);
    fire("contextmenu", document);

    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it("afterLeave detaches: F on the grid no longer closes (host handler regains F)", () => {
    ctx = makeCtx();
    afterEnter.call(ctx);
    afterLeave.call(ctx);

    fire("keydown", document, { key: "f" });
    fire("contextmenu", document);
    fire("contextmenu", document);

    expect(ctx.close).not.toHaveBeenCalled();
    ctx = null; // already detached; skip afterEach re-detach
  });
});
