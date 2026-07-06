// Pins the frame slideshow's load-aware scheduling: the advance timer is armed
// only AFTER a slide paints, slow loads are never aborted by the timer, failed
// or hung loads skip forward, and the crossfade cleanup never clobbers a load
// that has since started on the recycled layer. These are the exact regressions
// that froze the Pi Zero 2 W frame on slow Wi-Fi.
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

function makeEl() {
  const classes = new Set();
  return {
    className: '',
    children: [],
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    appendChild(child) {
      this.children.push(child);
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

globalThis.document = {
  createElement: (tag) => (tag === 'img' ? makeImg() : makeEl()),
};
globalThis.window = { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1 };
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

const { Slideshow } = await import('../../frame/slideshow.js');

const PHOTOS = [
  { hash: 'aaa', w: 100, h: 100, title: 'a', takenAt: '' },
  { hash: 'bbb', w: 100, h: 100, title: 'b', takenAt: '' },
  { hash: 'ccc', w: 100, h: 100, title: 'c', takenAt: '' },
];

function loadingLayer(s) {
  return s.layers[1 - s.active];
}

describe('Slideshow scheduling', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  it('does not abort an in-flight load when the slide duration elapses', () => {
    const s = new Slideshow(makeEl());
    s.setSlideDuration(5);
    s.start(PHOTOS, 0);

    const img = loadingLayer(s).img;
    const firstSrc = img.getAttribute('src');
    assert.match(firstSrc, /aaa/);

    // Slow network: duration passes with no onload. The old setInterval design
    // replaced img.src here, so nothing ever painted.
    mock.timers.tick(6000);
    assert.equal(s.index, 0);
    assert.equal(img.getAttribute('src'), firstSrc);
  });

  it('arms the advance timer only after the slide paints', () => {
    const s = new Slideshow(makeEl());
    s.setSlideDuration(5);
    s.start(PHOTOS, 0);

    loadingLayer(s).img.onload();
    assert.equal(s.index, 0);

    mock.timers.tick(5000);
    assert.equal(s.index, 1);
    assert.match(loadingLayer(s).img.getAttribute('src'), /bbb/);
  });

  it('skips forward quickly when a slide fails to load', () => {
    const s = new Slideshow(makeEl());
    s.setSlideDuration(10);
    s.start(PHOTOS, 0);

    loadingLayer(s).img.onerror();
    mock.timers.tick(2000); // ERROR_SKIP_MS
    assert.equal(s.index, 1);
  });

  it('abandons a hung load via the watchdog and moves on', () => {
    const s = new Slideshow(makeEl());
    s.setSlideDuration(10);
    s.start(PHOTOS, 0);

    mock.timers.tick(20000); // LOAD_TIMEOUT_MS — no onload ever fires
    mock.timers.tick(2000); // ERROR_SKIP_MS
    assert.equal(s.index, 1);
  });

  it('never clears a load that started on the recycled layer during crossfade cleanup', () => {
    const s = new Slideshow(makeEl());
    s.setSlideDuration(10);
    s.start(PHOTOS, 0);
    loadingLayer(s).img.onload(); // slide aaa painted

    // Advance immediately: the new load lands on the layer the crossfade
    // cleanup is about to clear.
    s.next();
    const img = loadingLayer(s).img;
    const pendingSrc = img.getAttribute('src');
    assert.match(pendingSrc, /bbb/);

    mock.timers.tick(900); // CROSSFADE_MS cleanup from slide aaa's apply()
    assert.equal(img.getAttribute('src'), pendingSrc);
  });

  it('marks the root paused/resumed for the on-screen badge', () => {
    const s = new Slideshow(makeEl());
    s.start(PHOTOS, 0);

    s.pause();
    assert.equal(s.root.classList.contains('paused'), true);
    s.resume();
    assert.equal(s.root.classList.contains('paused'), false);
  });
});
