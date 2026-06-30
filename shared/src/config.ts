import { z } from 'zod';

export const TransitionSchema = z.enum(['cut', 'fade', 'slide_left', 'slide_right']);
export type Transition = z.infer<typeof TransitionSchema>;

export const PhotoOrderSchema = z.enum(['shuffle', 'chronological', 'newest_first', 'date_cluster']);
export type PhotoOrder = z.infer<typeof PhotoOrderSchema>;

export const NightConfigSchema = z.object({
  start: z.string(),
  end: z.string(),
  dimPercent: z.number().min(0).max(100).default(25),
  warmth: z.number().min(0).max(100).default(30),
});
export type NightConfig = z.infer<typeof NightConfigSchema>;

export const ScheduleConfigSchema = z.object({
  on: z.string(),
  off: z.string(),
});
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;

export const DisplayConfigSchema = z.object({
  slideDurationSecs: z.number().positive().default(10),
  transition: TransitionSchema.default('fade'),
  transitionMs: z.number().positive().default(800),
  fillScreen: z.boolean().default(false),
  letterboxBlur: z.boolean().default(true),
  kenBurns: z.boolean().default(false),
  showOsd: z.boolean().default(true),
  showClock: z.boolean().default(false),
  order: PhotoOrderSchema.default('shuffle'),
  onThisDayBoost: z.boolean().default(true),
  maxImageMb: z.number().positive().default(100),
  maxMegapixels: z.number().positive().default(64),
  night: NightConfigSchema.optional(),
  schedule: ScheduleConfigSchema.optional(),
});
export type DisplayConfig = z.infer<typeof DisplayConfigSchema>;
