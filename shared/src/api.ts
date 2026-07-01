import { z } from 'zod';
import { PhotoMetaSchema } from './photo.js';
import { DisplayConfigSchema } from './config.js';

export const SlideshowStateSchema = z.object({
  index: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  paused: z.boolean(),
  displayOn: z.boolean(),
  photo: PhotoMetaSchema.nullable(),
  // The upcoming photo, so the client can prefetch it during the current
  // slide's dwell (warms the server resize + browser cache ahead of the swap).
  nextPhoto: PhotoMetaSchema.nullable(),
  startedAt: z.string(),
});
export type SlideshowState = z.infer<typeof SlideshowStateSchema>;

export { DisplayConfigSchema };
export type { DisplayConfig } from './config.js';

// Read-only viewer: actions are all local slideshow navigation. Nothing here
// mutates the PhotoPrism backend (`goto` just moves the cursor by photo id).
export const ControlActionSchema = z.object({
  action: z.enum(['next', 'prev', 'toggle_pause', 'pause', 'resume', 'goto']),
  id: z.string().optional(),
});
export type ControlAction = z.infer<typeof ControlActionSchema>;

export const PhotosQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(60),
  offset: z.coerce.number().int().nonnegative().default(0),
  q: z.string().optional(),
});

export const ImageQuerySchema = z.object({
  w: z.coerce.number().int().min(16).max(8192),
  h: z.coerce.number().int().min(16).max(8192),
  fit: z.enum(['cover', 'contain']).default('contain'),
  fmt: z.enum(['auto', 'webp', 'jpeg', 'avif']).default('auto'),
});

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
