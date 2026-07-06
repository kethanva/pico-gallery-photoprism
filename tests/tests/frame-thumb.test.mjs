import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { slideshowSize, snapFitSize, thumbUrl } from '../../frame/thumb.js';

describe('slideshowSize', () => {
  it('caps at fit_1280 regardless of viewport — 512 MB Pi decode budget', () => {
    assert.equal(slideshowSize(1920, 1080, 1), 'fit_1280');
    assert.equal(slideshowSize(3840, 2160, 2), 'fit_1280');
  });

  it('drops to fit_720 on small screens', () => {
    assert.equal(slideshowSize(720, 480, 1), 'fit_720');
    assert.equal(slideshowSize(480, 320, 1), 'fit_720');
  });

  it('accounts for devicePixelRatio and defaults a falsy dpr to 1', () => {
    assert.equal(slideshowSize(640, 360, 2), 'fit_1280');
    assert.equal(slideshowSize(720, 480, 0), 'fit_720');
  });
});

describe('thumbUrl', () => {
  it('builds the PhotoPrism thumbnail API path', () => {
    assert.equal(thumbUrl('abc123', 'tok', 'fit_1280'), '/api/v1/t/abc123/tok/fit_1280');
  });
});

describe('snapFitSize (frame copy)', () => {
  it('snaps to registered PhotoPrism fit sizes', () => {
    assert.equal(snapFitSize(1280), 1280);
    assert.equal(snapFitSize(1281), 1600);
    assert.equal(snapFitSize(99999), 7680);
  });
});
