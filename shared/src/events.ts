import { SlideshowStateSchema } from './api.js';
import { z } from 'zod';

export const SseStateEventSchema = z.object({
  type: z.literal('state'),
  data: SlideshowStateSchema,
});

export const SseDisplayEventSchema = z.object({
  type: z.literal('display'),
  data: z.object({ on: z.boolean() }),
});

export const SseSourceEventSchema = z.object({
  type: z.literal('source'),
  data: z.object({
    name: z.string(),
    auth: z.enum(['authenticated', 'pending', 'unauthenticated']),
    message: z.string().optional(),
    pollSecs: z.number().optional(),
  }),
});

export const SseEventSchema = z.discriminatedUnion('type', [
  SseStateEventSchema,
  SseDisplayEventSchema,
  SseSourceEventSchema,
]);
export type SseEvent = z.infer<typeof SseEventSchema>;
