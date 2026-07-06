// End-to-end wiring test for the frame client: imports the REAL main.js with a
// stubbed DOM + fetch, boots it, then drives repeated F-key fullscreen↔grid
// toggles. Pins the full exit-fullscreen path (input → toggleSurface →
// grid.show tiles populated → back to a painting slideshow) across cycles.
import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';

import { setImmediate } from 'node:timers';

// Mock timers BEFORE importing main.js so boot's AbortController timeouts and
// the slideshow's schedule timers never hold the process open.
mock.timers.enable({ apis: ['setTimeout'] });

function makeEl() {
  const classes = new Set();
  const listeners = {};
  return {
    className: '',
    children: [],
    style: {},
    dataset: {},
    scrollTop: 0,
    clientWidth: 360,
    clientHeight: 600,
    textContent: '',
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    appendChild(child) {
      this.children.push(child);
    },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    dispatch(type, ev) {
      (listeners[type] || []).forEach((fn) => fn(ev));
    },
  };
}

function makeImg() {
  const attrs = new Map();
  return {
    alt: '',
    decoding: '',
    loading: '',
    onload: null,
    onerror: null,
    setAttribute(k, v) {
      attrs.set(k, String(v));
    },
    getAttribute(k) {
      return attrs.has(k) ? attrs.get(k) : null;
    },
    removeAttribute(k) {
      attrs.delete(k);
    },
    set src(v) {
      attrs.set('src', String(v));
    },
    get src() {
      return attrs.get('src') || '';
    },
  };
}

const app = makeEl();
const loadingEl = makeEl();
const docListeners = {};

globalThis.document = {
  createElement: (tag) => (tag === 'img' ? makeImg() : makeEl()),
  getElementById: (id) => (id === 'app' ? app : loadingEl),
  addEventListener(type, fn) {
    (docListeners[type] ||= []).push(fn);
  },
};
globalThis.window = {
  innerWidth: 1920,
  innerHeight: 1080,
  devicePixelRatio: 1,
  addEventListener() {},
};
globalThis.requestAnimationFrame = (fn) => {
  fn();
  return 0;
};
globalThis.Image = class {
  constructor() {
    this.decoding = '';
    this._src = '';
  }
  set src(v) {
    this._src = v;
  }
  get src() {
    return this._src;
  }
  decode() {
    return Promise.resolve();
  }
};

const PHOTOS = Array.from({ length: 12 }, (_, i) => ({
  hash: `h${i}`,
  w: 100,
  h: 100,
  title: `p${i}`,
  takenAt: '',
}));

globalThis.fetch = async (url) => {
  const body =
    String(url) === '/frame/playlist'
      ? PHOTOS
      : String(url) === '/config.json'
        ? { kioskConfig: { slideDuration: 5 } }
        : { previewToken: 'tok' }; // /api/v1/config
  return { ok: true, json: async () => body };
};

// main.js layout: app.children[0] = slideshow root, app.children[1] = grid root.
const slideshowRoot = () => app.children[0];
const gridRoot = () => app.children[1];

function firePendingSlideLoad() {
  for (const layer of slideshowRoot().children) {
    const img = layer.children[0];
    if (typeof img.onload === 'function' && img.getAttribute('src')) {
      img.onload();
      return img;
    }
  }
  return null;
}

function gridTilesWithSrc() {
  const spacer = gridRoot().children[0];
  return spacer.children.filter((cell) => cell.children[0].getAttribute('src')).length;
}

function pressF() {
  docListeners.keydown.forEach((fn) =>
    fn({
      key: 'f',
      defaultPrevented: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      target: { tagName: 'BODY', isContentEditable: false },
      preventDefault() {},
    }),
  );
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('frame main.js end-to-end surface toggling', () => {
  before(async () => {
    await import('../../frame/main.js');
    for (let i = 0; i < 10; i++) await flush(); // let boot() settle
  });

  it('boots into a painting slideshow and hides the loader', () => {
    assert.equal(loadingEl.classList.contains('hidden'), true);
    const img = firePendingSlideLoad();
    assert.ok(img, 'first slide should be loading at boot');
  });

  it('survives three fullscreen↔grid cycles with populated tiles every time', () => {
    for (let cycle = 1; cycle <= 3; cycle++) {
      pressF(); // exit fullscreen slideshow → grid
      assert.equal(gridRoot().classList.contains('visible'), true, `cycle ${cycle}: grid visible`);
      assert.ok(gridTilesWithSrc() > 0, `cycle ${cycle}: grid tiles populated`);

      pressF(); // back to fullscreen slideshow
      assert.equal(gridRoot().classList.contains('visible'), false, `cycle ${cycle}: grid hidden`);
      assert.equal(gridTilesWithSrc(), 0, `cycle ${cycle}: tile memory released`);
      assert.equal(slideshowRoot().classList.contains('hidden'), false, `cycle ${cycle}: slideshow revealed`);
      const img = firePendingSlideLoad();
      assert.ok(img, `cycle ${cycle}: slideshow reloads its slide after reveal`);
      assert.equal(slideshowRoot().classList.contains('paused'), false, `cycle ${cycle}: not stuck paused`);
    }
  });
});
