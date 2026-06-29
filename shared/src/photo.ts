import { z } from 'zod';

export const PhotoMetaSchema = z.object({
  id: z.string(),
  sourceName: z.string(),
  filename: z.string(),
  title: z.string().optional(),
  album: z.string().optional(),
  location: z.string().optional(),
  takenAt: z.string().optional(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  favorite: z.boolean().default(false),
  downloadUrl: z.string().optional(),
  contentHash: z.string().optional(),
  extra: z.record(z.string()).optional(),
});

export type PhotoMeta = z.infer<typeof PhotoMetaSchema>;

export const AuthStatusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('authenticated') }),
  z.object({ kind: z.literal('pending'), message: z.string(), pollSecs: z.number() }),
  z.object({ kind: z.literal('unauthenticated'), error: z.string().optional() }),
]);

export type AuthStatus = z.infer<typeof AuthStatusSchema>;
