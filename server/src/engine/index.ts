import type { SlideshowState } from '@pico/shared';
import type { RootConfig } from '../config/index.js';
import type { PhotoSource } from '../sources/source.js';
import { Playlist } from './playlist.js';
import { bus } from './bus.js';
import { isDisplayOn } from './schedule.js';
import { loadPersistedState, savePersistedState, flushPersistedState } from './state-store.js';
import { logger } from '../telemetry/logger.js';

export class SlideshowEngine {
  private playlist: Playlist = new Playlist();
  private paused = false;
  private displayOn = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scheduleCheck: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private startedAt = new Date().toISOString();
  // No-repeat guarantee: ids shown this cycle. Auto-advance skips these until
  // every photo has been shown once, then the set clears and a new cycle starts.
  private seen = new Set<string>();
  // Completed-cycle counter; salts the shuffle so each pass gets a fresh order.
  private cycle = 0;

  // How often to re-check the display on/off schedule window.
  private static readonly SCHEDULE_CHECK_MS = 30_000;
  // How often to rebuild the playlist from sources (pick up added/removed photos
  // and re-paged remote sources) without dropping the cursor.
  private static readonly REFRESH_MS = 15 * 60_000;

  constructor(
    private readonly sources: Map<string, PhotoSource>,
    private readonly cfg: RootConfig
  ) {}

  async start(): Promise<void> {
    const persisted = await loadPersistedState(this.cfg.cache.dir);
    this.cycle = persisted.cycle ?? 0;

    // Build initial playlist; retry on empty result (e.g. backend timeout at boot).
    const MAX_ATTEMPTS = 4;
    const RETRY_DELAY_MS = 30_000;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      this.playlist = await Playlist.build(this.sources, this.cfg.display, {
        resumePhotoId: persisted.photoId,
        seedSalt: String(this.cycle),
      });
      if (this.playlist.length > 0 || attempt >= MAX_ATTEMPTS) break;
      logger.warn(
        { attempt, maxAttempts: MAX_ATTEMPTS, retryInMs: RETRY_DELAY_MS },
        'Playlist built with 0 photos (source timeout?) — will retry'
      );
      await new Promise((res) => setTimeout(res, RETRY_DELAY_MS));
    }

    // Restore the seen-set, dropping ids of photos that have since disappeared.
    const ids = this.playlist.idSet();
    this.seen = new Set((persisted.seenIds ?? []).filter((id) => ids.has(id)));
    // Everything already shown (process died right at a cycle boundary) → new cycle.
    if (this.playlist.length > 0 && this.seen.size >= this.playlist.length) {
      this.seen.clear();
      this.cycle++;
    }
    this.markCurrentSeen();
    this.displayOn = isDisplayOn(this.cfg.display.schedule);
    this.scheduleTimer();
    // Re-evaluate the on/off window over time so the display follows the schedule
    // without a restart. Only needed when a schedule is actually configured.
    if (this.cfg.display.schedule) {
      this.scheduleCheck = setInterval(() => this.evaluateSchedule(), SlideshowEngine.SCHEDULE_CHECK_MS);
    }
    // Periodically rebuild the playlist so newly added/removed photos (and
    // re-paged remote sources) appear without a server restart.
    this.refreshTimer = setInterval(() => void this.refresh(), SlideshowEngine.REFRESH_MS);
    this.broadcast();
    logger.info('Slideshow engine started');
  }

  stop(): void {
    this.stopTimer();
    if (this.scheduleCheck) {
      clearInterval(this.scheduleCheck);
      this.scheduleCheck = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    // Persist the exact current state now — routine saves are throttled, so the
    // latest one may still be pending. Synchronous, so it survives process exit.
    flushPersistedState();
  }

  /**
   * Rebuild the playlist from the sources, keeping the cursor anchored to the
   * current photo by id (falls back to the start if it has since disappeared).
   * Cheap for local sources (re-reads their cached scan); guarded against
   * overlap so a slow remote refresh can't pile up.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const currentId = this.playlist.current()?.id;
      const fresh = await Playlist.build(this.sources, this.cfg.display, {
        seedSalt: String(this.cycle),
      });
      if (currentId) fresh.goto(currentId);
      this.playlist = fresh;
      this.broadcast();
      logger.debug({ total: fresh.length }, 'Playlist refreshed');
    } catch (err) {
      logger.error({ err }, 'Playlist refresh failed');
    } finally {
      this.refreshing = false;
    }
  }

  /** Recompute the schedule window; on a transition, emit a display event + state. */
  private evaluateSchedule(): void {
    const on = isDisplayOn(this.cfg.display.schedule);
    if (on === this.displayOn) return;
    this.displayOn = on;
    bus.publish({ type: 'display', data: { on } });
    this.broadcast();
    logger.info({ displayOn: on }, 'Display schedule transition');
  }

  getState(): SlideshowState {
    return {
      index: this.playlist.currentIndex,
      total: this.playlist.length,
      paused: this.paused,
      displayOn: this.displayOn,
      photo: this.playlist.current(),
      // Skip seen photos so the client prefetches what next() will actually show.
      nextPhoto: this.playlist.peekNextUnseen(this.seen),
      startedAt: this.startedAt,
    };
  }

  next(): void {
    this.advanceToUnseen();
    this.resetTimer();
    this.broadcast();
  }

  prev(): void {
    // Going back deliberately re-views an already-shown photo; no skipping here.
    this.playlist.prev();
    this.markCurrentSeen();
    this.resetTimer();
    this.broadcast();
  }

  pause(): void {
    this.paused = true;
    this.stopTimer();
    this.broadcast();
  }

  resume(): void {
    this.paused = false;
    this.scheduleTimer();
    this.broadcast();
  }

  togglePause(): void {
    if (this.paused) this.resume();
    else this.pause();
  }

  goto(id: string): boolean {
    const photo = this.playlist.goto(id);
    if (!photo) return false;
    this.markCurrentSeen();
    this.resetTimer();
    this.broadcast();
    return true;
  }

  getPlaylist(): Playlist {
    return this.playlist;
  }

  getSources(): Map<string, PhotoSource> {
    return this.sources;
  }

  private broadcast(): void {
    bus.publish({ type: 'state', data: this.getState() });
  }

  /**
   * Advance to the next photo that has not been shown this cycle. When every
   * photo has been shown, clear the seen-set, bump the cycle counter, and kick a
   * background rebuild so shuffle users get a fresh order for the new pass.
   */
  private advanceToUnseen(): void {
    const len = this.playlist.length;
    if (len === 0) return;
    for (let i = 0; i < len; i++) {
      const p = this.playlist.next();
      if (p && !this.seen.has(p.id)) {
        this.markCurrentSeen();
        return;
      }
    }
    // Wrapped all the way around: every photo has been shown once.
    this.seen.clear();
    this.cycle++;
    logger.info({ cycle: this.cycle, total: len }, 'Slideshow cycle complete — starting a new pass');
    this.playlist.next();
    this.markCurrentSeen();
    // Background reshuffle for the new cycle (deterministic orders rebuild
    // identically; the cursor stays anchored to the current photo either way).
    void this.refresh();
  }

  /** The current photo has been displayed: record it and schedule a state save.
   *  Best-effort, non-blocking; lets a restart resume without repeats. */
  private markCurrentSeen(): void {
    const photo = this.playlist.current();
    if (!photo) return;
    this.seen.add(photo.id);
    savePersistedState(this.cfg.cache.dir, () => ({
      photoId: this.playlist.current()?.id,
      seenIds: [...this.seen],
      cycle: this.cycle,
    }));
  }

  private scheduleTimer(): void {
    if (this.paused || this.timer) return;
    const ms = (this.cfg.display.slideDurationSecs ?? 10) * 1000;
    this.timer = setInterval(() => {
      // Hold on the current photo while paused or while the schedule has the
      // display off — no point cycling images nobody is looking at.
      if (!this.paused && this.displayOn) {
        this.advanceToUnseen();
        this.broadcast();
      }
    }, ms);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private resetTimer(): void {
    this.stopTimer();
    this.scheduleTimer();
  }
}

let _engine: SlideshowEngine | null = null;

export function setEngine(e: SlideshowEngine): void {
  _engine = e;
}

export function getEngine(): SlideshowEngine {
  if (!_engine) throw new Error('ENGINE_NOT_READY');
  return _engine;
}

export function engineReady(): boolean {
  return _engine !== null;
}
