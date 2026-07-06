// Pins the grid's hide/show cycle: hide() releases decoded images (Pi memory)
// AND invalidates the render window so the next show() repopulates tiles.
// Regression: with the window left intact, #layout early-returned on an
// unchanged scroll position and every exit from the fullscreen slideshow after
// the first showed a grid of blank tiles.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function makeEl() {
  const classes = new Set();
  return {
    className: '',
    children: [],
    style: {},
    dataset: {},
    scrollTop: 0,
    clientWidth: 360,
    clientHeight: 600,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    appendChild(child) {
      this.children.push(child);
    },
    addEventListener() {},
  };
}

function makeImg() {
  const attrs = new Map();
  return {
    alt: '',
    decoding: '',
    loading: '',
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

const { PhotoGrid } = await import('../../frame/grid.js');

const PHOTOS = Array.from({ length: 30 }, (_, i) => ({
  hash: `h${i}`,
  w: 100,
  h: 100,
  title: `p${i}`,
  takenAt: '',
}));

function tilesWithSrc(grid) {
  return grid.pool.filter((slot) => slot.img.getAttribute('src')).length;
}

describe('PhotoGrid hide/show cycle', () => {
  it('populates visible tiles on show', () => {
    const grid = new PhotoGrid(makeEl());
    grid.setPreviewToken('tok');
    grid.setPhotos(PHOTOS);
    grid.show();
    assert.ok(tilesWithSrc(grid) > 0);
  });

  it('releases every tile image on hide', () => {
    const grid = new PhotoGrid(makeEl());
    grid.setPreviewToken('tok');
    grid.setPhotos(PHOTOS);
    grid.show();
    grid.hide();
    assert.equal(tilesWithSrc(grid), 0);
  });

  it('repopulates tiles on every subsequent show — exit-fullscreen regression', () => {
    const grid = new PhotoGrid(makeEl());
    grid.setPreviewToken('tok');
    grid.setPhotos(PHOTOS);
    for (let cycle = 0; cycle < 3; cycle++) {
      grid.show();
      assert.ok(tilesWithSrc(grid) > 0, `grid blank after hide/show cycle ${cycle + 1}`);
      grid.hide();
    }
  });

  it('tile srcs use the preview token and tile_224 size', () => {
    const grid = new PhotoGrid(makeEl());
    grid.setPreviewToken('tok');
    grid.setPhotos(PHOTOS);
    grid.show();
    const src = grid.pool[0].img.getAttribute('src');
    assert.equal(src, '/api/v1/t/h0/tok/tile_224');
  });
});
