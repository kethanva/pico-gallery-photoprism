import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import TOML from '@iarna/toml';
import { RootConfigSchema, type RootConfig } from './schema.js';

function applyEnvOverrides(raw: Record<string, unknown>): void {
  for (const [key, val] of Object.entries(process.env)) {
    if (!key.startsWith('PICO_')) continue;
    const parts = key.slice(5).toLowerCase().split('_');
    if (parts.length < 2) continue;
    const section = parts[0];
    const field = parts.slice(1).join('_').replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const obj = raw[section] as Record<string, unknown> | undefined;
    if (obj && typeof obj === 'object') {
      obj[field] = val === 'true' ? true : val === 'false' ? false : isNaN(Number(val)) ? val : Number(val);
    }
  }
}

/**
 * Recursively rewrite object keys from TOML's idiomatic `snake_case` to the
 * `camelCase` the Zod schema expects. Values (album names, raw queries, etc.)
 * are left untouched; only keys are transformed. Arrays are walked element-wise
 * so `[[sources]]` tables and nested tables like `[device.wifi]` are covered.
 */
function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      out[key] = camelizeKeys(v);
    }
    return out;
  }
  return value;
}

function resolveConfigPath(): string | null {
  const candidates = [
    process.env['PICO_CONFIG'],
    join(homedir(), '.config', 'picogallery', 'config.toml'),
    '/etc/picogallery/config.toml',
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export async function loadConfig(): Promise<RootConfig> {
  const path = resolveConfigPath();
  let raw: Record<string, unknown> = {};
  if (path) {
    const text = await readFile(path, 'utf-8');
    raw = TOML.parse(text) as Record<string, unknown>;
  }
  applyEnvOverrides(raw);

  // TOML is snake_case by convention; the schema is camelCase. Normalize every
  // section (display, http, cache, each [[sources]], [device.wifi], …) so config
  // keys aren't silently dropped by the schema.
  raw = camelizeKeys(raw) as Record<string, unknown>;

  const result = RootConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${result.error.message}`);
  }
  return result.data;
}
