import type { ScheduleConfig, NightConfig } from '@pico/shared';

function parseTime(t: string): { h: number; m: number } {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return { h, m };
}

function minuteOfDay(h: number, m: number): number {
  return h * 60 + m;
}

export function timeInWindow(nowH: number, nowM: number, start: string, end: string): boolean {
  const now = minuteOfDay(nowH, nowM);
  const s = parseTime(start);
  const e = parseTime(end);
  const startMin = minuteOfDay(s.h, s.m);
  const endMin = minuteOfDay(e.h, e.m);

  if (startMin <= endMin) {
    return now >= startMin && now < endMin;
  }
  // Overnight window (e.g. 22:00 → 06:00)
  return now >= startMin || now < endMin;
}

export function isDisplayOn(schedule: ScheduleConfig | undefined, now = new Date()): boolean {
  if (!schedule) return true;
  return timeInWindow(now.getHours(), now.getMinutes(), schedule.on, schedule.off);
}

export function isNightMode(night: NightConfig | undefined, now = new Date()): boolean {
  if (!night) return false;
  return timeInWindow(now.getHours(), now.getMinutes(), night.start, night.end);
}
