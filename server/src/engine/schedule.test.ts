import { describe, it, expect } from 'vitest';
import { timeInWindow, isDisplayOn, isNightMode } from './schedule.js';

describe('timeInWindow', () => {
  it('matches a same-day window inclusively at start, exclusively at end', () => {
    expect(timeInWindow(8, 0, '08:00', '22:00')).toBe(true);
    expect(timeInWindow(21, 59, '08:00', '22:00')).toBe(true);
    expect(timeInWindow(22, 0, '08:00', '22:00')).toBe(false);
    expect(timeInWindow(7, 59, '08:00', '22:00')).toBe(false);
  });

  it('wraps an overnight window across midnight', () => {
    expect(timeInWindow(23, 0, '22:00', '06:00')).toBe(true);
    expect(timeInWindow(2, 0, '22:00', '06:00')).toBe(true);
    expect(timeInWindow(6, 0, '22:00', '06:00')).toBe(false);
    expect(timeInWindow(12, 0, '22:00', '06:00')).toBe(false);
  });
});

describe('isDisplayOn', () => {
  it('is always on when no schedule is configured', () => {
    expect(isDisplayOn(undefined)).toBe(true);
  });

  it('reflects the schedule window for a fixed clock', () => {
    const sched = { on: '08:00', off: '22:00' };
    expect(isDisplayOn(sched, new Date('2026-06-29T10:00:00'))).toBe(true);
    expect(isDisplayOn(sched, new Date('2026-06-29T23:00:00'))).toBe(false);
  });
});

describe('isNightMode', () => {
  it('is off when no night config is set', () => {
    expect(isNightMode(undefined)).toBe(false);
  });

  it('detects the night window', () => {
    const night = { start: '20:00', end: '07:00' };
    expect(isNightMode(night, new Date('2026-06-29T21:30:00'))).toBe(true);
    expect(isNightMode(night, new Date('2026-06-29T12:00:00'))).toBe(false);
  });
});
