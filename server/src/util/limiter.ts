/**
 * Bounds how many async tasks run at once. Used to cap concurrent image
 * decode/resize operations: libvips is told to use a single thread per op
 * (see tuneSharpForHost), but nothing otherwise stops N simultaneous HTTP image
 * requests from each spawning a full-resolution decode at the same time — on a
 * 512 MB Pi Zero 2 W that peak can OOM the box. A small limit serialises the
 * heavy work so peak memory stays bounded (and throughput actually improves,
 * since the weak CPU isn't thrashing between decodes).
 */
export class Limiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error('Limiter max must be >= 1');
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    // At capacity: park until a slot is handed over. The slot is *transferred*
    // to us on release (active is not decremented then), so it stays accurate.
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); // hand our slot straight to the next waiter (active unchanged)
    else this.active--; // no one waiting: free the slot
  }

  /** Run `fn` once a slot is free; the slot is released even if `fn` throws. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
