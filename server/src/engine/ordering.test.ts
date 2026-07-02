import { describe, it, expect } from 'vitest';
import type { PhotoMeta } from '@pico/shared';
import { orderPhotos } from './ordering.js';

function photo(id: string, takenAt?: string): PhotoMeta {
  return { id, sourceName: 'test', filename: `${id}.jpg`, width: 0, height: 0, favorite: false, takenAt };
}

const sample: PhotoMeta[] = [
  photo('a', '2024-01-10T00:00:00Z'),
  photo('b', '2023-06-01T00:00:00Z'),
  photo('c', '2025-12-31T00:00:00Z'),
];

describe('orderPhotos', () => {
  it('chronological sorts oldest → newest', () => {
    const ids = orderPhotos(sample, 'chronological', false).map((p) => p.id);
    expect(ids).toEqual(['b', 'a', 'c']);
  });

  it('newest_first sorts newest → oldest', () => {
    const ids = orderPhotos(sample, 'newest_first', false).map((p) => p.id);
    expect(ids).toEqual(['c', 'a', 'b']);
  });

  it('shuffle is deterministic for a given day and preserves the set', () => {
    const a = orderPhotos(sample, 'shuffle', false).map((p) => p.id);
    const b = orderPhotos(sample, 'shuffle', false).map((p) => p.id);
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual(['a', 'b', 'c']);
  });

  it('shuffle order changes with the seed salt (fresh order per cycle)', () => {
    const many = Array.from({ length: 20 }, (_, i) => photo(`p${i}`, `20${10 + i}-01-01T00:00:00Z`));
    const first = orderPhotos(many, 'shuffle', false).map((p) => p.id);
    const salted = orderPhotos(many, 'shuffle', false, 'cycle-1').map((p) => p.id);
    expect(salted).not.toEqual(first);
    expect([...salted].sort()).toEqual([...first].sort()); // same set, new order
  });

  it('keeps every photo when boosting on-this-day', () => {
    const today = new Date();
    const otd = photo('today', new Date(2010, today.getMonth(), today.getDate()).toISOString());
    const result = orderPhotos([...sample, otd], 'chronological', true);
    expect(result.map((p) => p.id).sort()).toEqual(['a', 'b', 'c', 'today']);
  });

  it('does not mutate the input array', () => {
    const input = [...sample];
    orderPhotos(input, 'newest_first', false);
    expect(input.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });
});
