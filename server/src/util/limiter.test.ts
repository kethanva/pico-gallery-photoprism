import { describe, it, expect } from 'vitest';
import { Limiter } from './limiter.js';

/** A promise you resolve by hand, to hold tasks "in flight" deterministically. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('Limiter', () => {
  it('never runs more than `max` tasks concurrently', async () => {
    const limiter = new Limiter(2);
    let active = 0;
    let peak = 0;
    const gate = deferred();

    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await gate.promise; // hold every task open until we release them together
      active--;
    };

    const runs = [task, task, task, task, task].map((t) => limiter.run(t));
    // Let the limiter admit as many as it will before anything completes.
    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(2);

    gate.resolve();
    await Promise.all(runs);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it('runs everything and preserves FIFO order under a limit of 1', async () => {
    const limiter = new Limiter(1);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((n) => limiter.run(async () => { order.push(n); }))
    );
    expect(order).toEqual([1, 2, 3]);
  });

  it('releases the slot even when a task throws', async () => {
    const limiter = new Limiter(1);
    await expect(limiter.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // If the slot leaked, this second task would hang forever.
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok');
  });
});
