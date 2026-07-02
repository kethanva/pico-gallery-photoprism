import type { PhotoMeta } from '@pico/shared';
import type { PhotoOrder } from '@pico/shared';

function seededRandom(seed: string): () => number {
  let h = 0xdeadbeef;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 2654435761);
  h ^= h >>> 16;
  return () => {
    h ^= h >>> 15;
    h = Math.imul(h, 2246822519);
    h ^= h >>> 13;
    h = Math.imul(h, 3266489917);
    h ^= h >>> 16;
    return (h >>> 0) / 0xffffffff;
  };
}

function shuffleWithSeed<T>(arr: T[], seed: string): T[] {
  const result = [...arr];
  const rand = seededRandom(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

function isOnThisDay(photo: PhotoMeta): boolean {
  if (!photo.takenAt) return false;
  const taken = new Date(photo.takenAt);
  const now = new Date();
  return taken.getMonth() === now.getMonth() && taken.getDate() === now.getDate();
}

/**
 * @param seedSalt Extra entropy mixed into the daily shuffle seed. The engine
 * passes its cycle counter so each full pass through the library gets a fresh
 * permutation instead of replaying the same day-seeded order.
 */
export function orderPhotos(
  photos: PhotoMeta[],
  order: PhotoOrder,
  boostOnThisDay: boolean,
  seedSalt = ''
): PhotoMeta[] {
  let result: PhotoMeta[];
  const seed = new Date().toISOString().slice(0, 10) + (seedSalt ? `:${seedSalt}` : '');

  switch (order) {
    case 'shuffle':
      result = shuffleWithSeed(photos, seed);
      break;
    case 'chronological':
      result = [...photos].sort((a, b) => (a.takenAt ?? '').localeCompare(b.takenAt ?? ''));
      break;
    case 'newest_first':
      result = [...photos].sort((a, b) => (b.takenAt ?? '').localeCompare(a.takenAt ?? ''));
      break;
    case 'date_cluster': {
      const shuffled = shuffleWithSeed(photos, seed);
      const byMonth = new Map<string, PhotoMeta[]>();
      for (const p of shuffled) {
        const key = p.takenAt ? p.takenAt.slice(0, 7) : 'unknown';
        if (!byMonth.has(key)) byMonth.set(key, []);
        byMonth.get(key)!.push(p);
      }
      result = [];
      const months = [...byMonth.keys()].sort().reverse();
      for (const m of months) result.push(...byMonth.get(m)!);
      break;
    }
  }

  if (boostOnThisDay) {
    // Single pass keeps input order within each group and builds one Date per
    // photo instead of two (this runs over the whole library on every refresh).
    const onThisDay: PhotoMeta[] = [];
    const rest: PhotoMeta[] = [];
    for (const p of result) (isOnThisDay(p) ? onThisDay : rest).push(p);
    if (onThisDay.length > 0) {
      const step = Math.max(1, Math.floor(rest.length / onThisDay.length));
      const final: PhotoMeta[] = [];
      let otdIdx = 0;
      for (let i = 0; i < rest.length; i++) {
        if (otdIdx < onThisDay.length && i % step === 0) {
          final.push(onThisDay[otdIdx++]!);
        }
        final.push(rest[i]!);
      }
      while (otdIdx < onThisDay.length) final.push(onThisDay[otdIdx++]!);
      return final;
    }
  }

  return result;
}
