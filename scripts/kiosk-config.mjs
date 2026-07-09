import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const profilesData = JSON.parse(
  readFileSync(join(ROOT, 'config/kiosk-profiles.json'), 'utf8'),
);

const ALLOWED_PREVIEW_SIZES = new Set(['fit_720', 'fit_1280']);
const ALLOWED_THUMB_SIZES = new Set(['fit_720']);
const ALLOWED_PROFILES = new Set(Object.keys(profilesData.profiles));
const DEFAULT_PROFILE =
  typeof profilesData.defaultProfile === 'string' && ALLOWED_PROFILES.has(profilesData.defaultProfile)
    ? profilesData.defaultProfile
    : 'pi_zero_2';

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

function asBool(value, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  return fallback;
}

export function resolveKioskConfig(input = {}) {
  const profileName =
    typeof input.profile === 'string' && ALLOWED_PROFILES.has(input.profile)
      ? input.profile
      : DEFAULT_PROFILE;
  const base = profilesData.profiles[profileName] || profilesData.profiles[DEFAULT_PROFILE];
  const merged = { ...base, ...input, profile: profileName };

  const previewSize = ALLOWED_PREVIEW_SIZES.has(merged.previewSize)
    ? merged.previewSize
    : base.previewSize;
  const thumbSize = ALLOWED_THUMB_SIZES.has(merged.thumbSize) ? merged.thumbSize : base.thumbSize;

  return {
    profile: profileName,
    previewSize,
    thumbSize,
    firstPageSize: clampInt(merged.firstPageSize, 4, 24, base.firstPageSize),
    pageSize: clampInt(merged.pageSize, 8, 32, base.pageSize),
    maxGridRows: clampInt(merged.maxGridRows, 6, 24, base.maxGridRows),
    restoreRowBatch: clampInt(merged.restoreRowBatch, 1, 4, base.restoreRowBatch),
    eagerThumbCount: clampInt(merged.eagerThumbCount, 0, 24, base.eagerThumbCount),
    thumbLoadConcurrency: clampInt(merged.thumbLoadConcurrency, 1, 8, base.thumbLoadConcurrency),
    backgroundFillTarget: clampInt(merged.backgroundFillTarget, 0, 200, base.backgroundFillTarget),
    backgroundFillDelayMs: clampInt(merged.backgroundFillDelayMs, 500, 10000, base.backgroundFillDelayMs),
    scrollIdleMs: clampInt(merged.scrollIdleMs, 100, 1000, base.scrollIdleMs),
    pruneCooldownMs: clampInt(merged.pruneCooldownMs, 100, 1000, base.pruneCooldownMs),
    slideDuration: clampInt(merged.slideDuration, 3, 60, base.slideDuration),
    autoSlideshow: asBool(merged.autoSlideshow, base.autoSlideshow),
    virtualFullscreenOnly: asBool(merged.virtualFullscreenOnly, base.virtualFullscreenOnly),
    suspendGridInPreview: asBool(merged.suspendGridInPreview, base.suspendGridInPreview),
    prefetchNextSlide: asBool(merged.prefetchNextSlide, base.prefetchNextSlide),
  };
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
