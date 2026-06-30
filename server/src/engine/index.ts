import type { SlideshowState } from '@pico/shared';
import type { RootConfig } from '../config/index.js';
import type { PhotoSource } from '../sources/source.js';
import { Playlist } from './playlist.js';
import { bus } from './bus.js';
import { isDisplayOn } from './schedule.js';
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
    this.playlist = await Playlist.build(this.sources, this.cfg.display);
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
      const fresh = await Playlist.build(this.sources, this.cfg.display);
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
      nextPhoto: this.playlist.peekNext(),
      startedAt: this.startedAt,
    };
  }

  next(): void {
    this.playlist.next();
    this.resetTimer();
    this.broadcast();
  }

  prev(): void {
    this.playlist.prev();
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
    this.resetTimer();
    this.broadcast();
    return true;
  }

  async toggleFavorite(id: string): Promise<void> {
    const photo = this.playlist.findById(id);
    if (!photo) return;
    photo.favorite = !photo.favorite;
    const source = this.sources.get(photo.sourceName);
    if (source?.setFavorite) {
      await source.setFavorite(photo, photo.favorite).catch((e: unknown) => logger.error(e, 'setFavorite failed'));
    }
    this.broadcast();
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

  private scheduleTimer(): void {
    if (this.paused || this.timer) return;
    const ms = (this.cfg.display.slideDurationSecs ?? 10) * 1000;
    this.timer = setInterval(() => {
      // Hold on the current photo while paused or while the schedule has the
      // display off — no point cycling images nobody is looking at.
      if (!this.paused && this.displayOn) {
        this.playlist.next();
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
