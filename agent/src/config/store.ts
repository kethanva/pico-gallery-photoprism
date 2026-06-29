import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ApplianceConfigSchema, type ApplianceConfig } from './schema.js';

/**
 * Resolve the appliance config directory. Overridable for tests and for the
 * read-only-rootfs case on the Pi (point at a writable overlay path).
 */
export function configDir(): string {
  return process.env['PICO_APPLIANCE_DIR'] ?? join(homedir(), '.config', 'picogallery');
}

export function configPath(): string {
  return join(configDir(), 'appliance.json');
}

/** Load config, applying schema defaults. Returns defaults if no file exists. */
export async function loadAppliance(): Promise<ApplianceConfig> {
  const path = configPath();
  if (!existsSync(path)) {
    return ApplianceConfigSchema.parse({});
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }
  const result = ApplianceConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid appliance config at ${path}:\n${result.error.message}`);
  }
  return result.data;
}

/**
 * Persist config atomically (write temp → rename) with 0600 perms so secrets
 * (backend token, control token) are not world-readable. Validates first.
 */
export async function saveAppliance(cfg: ApplianceConfig): Promise<ApplianceConfig> {
  const validated = ApplianceConfigSchema.parse(cfg);
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(validated, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600);
  // rename is atomic within the same directory.
  await (await import('node:fs/promises')).rename(tmp, path);
  return validated;
}

/** Merge a partial update over the current config and persist. */
export async function updateAppliance(patch: Partial<ApplianceConfig>): Promise<ApplianceConfig> {
  const current = await loadAppliance();
  return saveAppliance(ApplianceConfigSchema.parse({ ...current, ...patch }));
}
