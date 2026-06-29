import type { NightConfig } from '@pico/shared';

function minuteOfDay(h: number, m: number): number {
  return h * 60 + m;
}

function inWindow(now: Date, start: string, end: string): boolean {
  const [sh = 0, sm = 0] = start.split(':').map(Number);
  const [eh = 0, em = 0] = end.split(':').map(Number);
  const n = minuteOfDay(now.getHours(), now.getMinutes());
  const s = minuteOfDay(sh, sm);
  const e = minuteOfDay(eh, em);
  if (s <= e) return n >= s && n < e;
  return n >= s || n < e;
}

export class NightMode {
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly stage: HTMLElement, private readonly cfg: NightConfig | undefined) {}

  start(): void {
    if (!this.cfg) return;
    this.apply();
    this.interval = setInterval(() => this.apply(), 60_000);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  private apply(): void {
    if (!this.cfg) return;
    const isNight = inWindow(new Date(), this.cfg.start, this.cfg.end);
    if (isNight) {
      // dimPercent → brightness (25% dim = 0.75 brightness); warmth → sepia (0..1).
      const brightness = Math.max(0, 1 - this.cfg.dimPercent / 100);
      const sepia = Math.min(1, Math.max(0, this.cfg.warmth / 100));
      this.stage.style.setProperty('--night-brightness', String(brightness));
      this.stage.style.setProperty('--night-sepia', String(sepia));
    }
    this.stage.classList.toggle('night-mode', isNight);
  }
}
