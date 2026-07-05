import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { snapFitSize, compactPhoto } from '../../scripts/frame-utils.mjs';

describe('snapFitSize', () => {
  it('returns the smallest fit size that fits the pixel count', () => {
    assert.equal(snapFitSize(100), 720);
    assert.equal(snapFitSize(720), 720);
    assert.equal(snapFitSize(721), 1280);
    assert.equal(snapFitSize(1920), 1920);
    assert.equal(snapFitSize(1921), 2048);
  });

  it('returns the largest size when input exceeds all fit sizes', () => {
    assert.equal(snapFitSize(10000), 7680);
  });
});

describe('compactPhoto', () => {
  it('compacts PascalCase PhotoPrism records', () => {
    assert.deepEqual(compactPhoto({
      Hash: 'abc123',
      Width: 4032,
      Height: 3024,
      Title: 'Sunset',
      TakenAt: '2024-06-01T18:30:00Z',
    }), {
      hash: 'abc123',
      w: 4032,
      h: 3024,
      title: 'Sunset',
      takenAt: '2024-06-01T18:30:00Z',
    });
  });

  it('compacts camelCase records', () => {
    assert.deepEqual(compactPhoto({
      hash: 'def456',
      width: 800,
      height: 600,
      title: 'Beach',
      takenAt: '2023-01-15',
    }), {
      hash: 'def456',
      w: 800,
      h: 600,
      title: 'Beach',
      takenAt: '2023-01-15',
    });
  });

  it('returns null when hash is missing', () => {
    assert.equal(compactPhoto({ Width: 100, Height: 100 }), null);
  });

  it('extracts hash from Files when top-level Hash is missing', () => {
    assert.deepEqual(compactPhoto({
      Files: [{ Primary: true, Hash: 'from-files' }],
    }), {
      hash: 'from-files',
      w: 0,
      h: 0,
      title: '',
      takenAt: '',
    });
  });

  it('defaults missing fields to empty strings or zero', () => {
    assert.deepEqual(compactPhoto({ Hash: 'x' }), {
      hash: 'x',
      w: 0,
      h: 0,
      title: '',
      takenAt: '',
    });
  });
});
