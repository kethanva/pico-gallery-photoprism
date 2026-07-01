import { z } from 'zod';
import { DisplayConfigSchema } from '@pico/shared';

const PhotoPrismSourceSchema = z.object({
  name: z.literal('photoprism'),
  enabled: z.boolean().default(true),
  url: z.string().url(),
  username: z.string(),
  password: z.string().optional(),
  appPassword: z.string().optional(),
  album: z.string().optional(),
  albums: z.array(z.string()).optional(),
  favorites: z.boolean().optional(),
  quality: z.number().min(1).max(5).optional(),
  country: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
  year: z.number().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  color: z.string().optional(),
  mono: z.boolean().optional(),
  panorama: z.boolean().optional(),
  orientation: z.enum(['portrait', 'landscape', 'square']).optional(),
  people: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  memories: z.boolean().optional(),
  mediaType: z.enum(['image', 'video', 'live']).optional(),
  query: z.string().optional(),
  includePrivate: z.boolean().default(false),
  includeArchived: z.boolean().default(false),
  order: z.string().default('newest'),
  perPage: z.number().int().positive().default(100),
  maxThumb: z.string().default('fit_1920'),
  skipTlsVerify: z.boolean().default(false),
  requestTimeoutSecs: z.number().positive().default(30),
});

const WebDavSourceSchema = z.object({
  name: z.literal('webdav'),
  enabled: z.boolean().default(true),
  url: z.string().url(),
  username: z.string().optional(),
  password: z.string().optional(),
  token: z.string().optional(),
  recursive: z.boolean().default(true),
  skipTlsVerify: z.boolean().default(false),
});

export const SourceConfigSchema = z.discriminatedUnion('name', [
  PhotoPrismSourceSchema,
  WebDavSourceSchema,
]);
export type SourceConfig = z.infer<typeof SourceConfigSchema>;
export type PhotoPrismConfig = z.infer<typeof PhotoPrismSourceSchema>;
export type WebDavConfig = z.infer<typeof WebDavSourceSchema>;

export const RootConfigSchema = z.object({
  display: DisplayConfigSchema.default({}),
  cache: z.object({
    dir: z.string().optional(),
    maxMb: z.number().positive().default(256),
  }).default({}),
  http: z.object({
    host: z.string().default('0.0.0.0'),
    port: z.number().int().positive().default(8188),
    authToken: z.string().optional(),
    corsOrigins: z.array(z.string()).optional(),
  }).default({}),
  sources: z.array(SourceConfigSchema).default([]),
  device: z.object({
    hdmiPower: z.boolean().default(false),
    displayOnCmd: z.string().default('vcgencmd display_power 1'),
    displayOffCmd: z.string().default('vcgencmd display_power 0'),
    wifi: z.object({
      ssid: z.string(),
      password: z.string(),
      country: z.string().optional(),
    }).optional(),
  }).optional(),
});
export type RootConfig = z.infer<typeof RootConfigSchema>;
