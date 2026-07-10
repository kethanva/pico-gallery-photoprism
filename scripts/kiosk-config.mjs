import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveKioskConfigFrom } from '../config/kiosk-config-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES_PATH = join(ROOT, 'config/kiosk-profiles.json');

let profilesData;
try {
  profilesData = JSON.parse(readFileSync(PROFILES_PATH, 'utf8'));
} catch (err) {
  // Fail fast with an actionable message: a bundle without the profile data
  // must not boot the host into an undefined kiosk configuration.
  throw new Error(
    `kiosk-config: cannot load ${PROFILES_PATH} (${err.message}); ` +
      'the config/ directory must ship alongside scripts/',
  );
}

export function resolveKioskConfig(input = {}) {
  return resolveKioskConfigFrom(profilesData, input);
}

function readTomlValue(body, key) {
  const str = body.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm'));
  if (str) {
    return str[1];
  }
  const bool = body.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)`, 'm'));
  if (bool) {
    return bool[1] === 'true';
  }
  const num = body.match(new RegExp(`^\\s*${key}\\s*=\\s*([0-9]+)`, 'm'));
  if (num) {
    return Number(num[1]);
  }
  return undefined;
}

export function parseKioskTomlOverrides(toml = '') {
  const section = toml.match(/\[kiosk\]([\s\S]*?)(?=\n\[|$)/);
  if (!section) {
    return {};
  }
  const body = section[1];
  const overrides = {};
  const map = {
    profile: 'profile',
    preview_size: 'previewSize',
    thumb_size: 'thumbSize',
    first_page_size: 'firstPageSize',
    page_size: 'pageSize',
    max_grid_rows: 'maxGridRows',
    restore_row_batch: 'restoreRowBatch',
    eager_thumb_count: 'eagerThumbCount',
    thumb_load_concurrency: 'thumbLoadConcurrency',
    background_fill_target: 'backgroundFillTarget',
    background_fill_delay_ms: 'backgroundFillDelayMs',
    scroll_idle_ms: 'scrollIdleMs',
    prune_cooldown_ms: 'pruneCooldownMs',
    slide_duration: 'slideDuration',
    auto_slideshow: 'autoSlideshow',
    virtual_fullscreen_only: 'virtualFullscreenOnly',
    suspend_grid_in_preview: 'suspendGridInPreview',
    prefetch_next_slide: 'prefetchNextSlide',
  };
  for (const [tomlKey, jsKey] of Object.entries(map)) {
    const value = readTomlValue(body, tomlKey);
    if (value !== undefined) {
      overrides[jsKey] = value;
    }
  }
  return overrides;
}

export function buildKioskConfig({ toml = '', slideDurationSecs, env = process.env } = {}) {
  const overrides = parseKioskTomlOverrides(toml);
  if (env.PICO_KIOSK_PROFILE) {
    overrides.profile = env.PICO_KIOSK_PROFILE;
  }
  if (env.PICO_KIOSK_PREVIEW_SIZE) {
    overrides.previewSize = env.PICO_KIOSK_PREVIEW_SIZE;
  }
  if (env.PICO_KIOSK_THUMB_SIZE) {
    overrides.thumbSize = env.PICO_KIOSK_THUMB_SIZE;
  }
  if (env.PICO_KIOSK_MAX_GRID_ROWS) {
    overrides.maxGridRows = Number(env.PICO_KIOSK_MAX_GRID_ROWS);
  }
  if (env.PICO_KIOSK_BACKGROUND_FILL_TARGET) {
    overrides.backgroundFillTarget = Number(env.PICO_KIOSK_BACKGROUND_FILL_TARGET);
  }
  if (slideDurationSecs != null && slideDurationSecs > 0) {
    overrides.slideDuration = slideDurationSecs;
  }
  return resolveKioskConfig(overrides);
}
