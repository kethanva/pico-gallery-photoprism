import { z } from 'zod';

// Time-of-day "HH:MM" (24h) used for the optional display-blank schedule.
const TimeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24-hour)');

export const DisplaySchema = z.object({
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  // Optional screen-blank window (e.g. blank overnight). Both required together.
  blankStart: TimeOfDay.optional(),
  blankEnd: TimeOfDay.optional(),
});

export const ApplianceConfigSchema = z
  .object({
    // The external PhotoPrism backend the kiosk talks to. Empty until configured.
    backendUrl: z.string().url().or(z.literal('')).default(''),
    // Optional PhotoPrism app password / token, forwarded by the proxy. Secret.
    backendToken: z.string().optional(),
    // Accept self-signed certs on the backend (common on LAN). Default true.
    ignoreCertificateErrors: z.boolean().default(true),
    // Local port the agent serves the SPA + control API + proxy on.
    kioskPort: z.number().int().positive().max(65535).default(8190),
    // Route the kiosk opens first inside the PhotoPrism SPA.
    startupPage: z.string().startsWith('/').default('/library'),
    windowTitle: z.string().default('Photo Frame'),
    display: DisplaySchema.default({}),
    // Optional bearer token guarding the /api/agent/* control surface. Secret.
    controlToken: z.string().optional(),
  })
  .strict();

export type ApplianceConfig = z.infer<typeof ApplianceConfigSchema>;
export type DisplayConfig = z.infer<typeof DisplaySchema>;

/** A config is "provisioned" once a backend URL is set. */
export function isProvisioned(cfg: ApplianceConfig): boolean {
  return cfg.backendUrl.trim().length > 0;
}

/**
 * The kiosk config.json contract consumed by frontend/dist/index.html and the
 * Cog launcher. Note serverUrl is intentionally empty: the SPA calls the API
 * same-origin and the agent proxies it, avoiding CORS/TLS issues in the browser.
 */
export interface KioskConfigJson {
  serverUrl: '';
  fullscreen: boolean;
  ignoreCertificateErrors: boolean;
  startupPage: string;
  windowTitle: string;
}

export function renderKioskConfig(cfg: ApplianceConfig): KioskConfigJson {
  return {
    serverUrl: '',
    fullscreen: true,
    ignoreCertificateErrors: cfg.ignoreCertificateErrors,
    startupPage: cfg.startupPage,
    windowTitle: cfg.windowTitle,
  };
}

/** Redact secrets for logging / API responses. */
export function redact(cfg: ApplianceConfig): ApplianceConfig {
  return {
    ...cfg,
    backendToken: cfg.backendToken ? '***' : undefined,
    controlToken: cfg.controlToken ? '***' : undefined,
  };
}
