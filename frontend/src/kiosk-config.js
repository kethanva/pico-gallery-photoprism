import profilesData from "../../config/kiosk-profiles.json";

const ALLOWED_PREVIEW_SIZES = new Set(["fit_720", "fit_1280"]);
const ALLOWED_THUMB_SIZES = new Set(["fit_720"]);
const ALLOWED_PROFILES = new Set(Object.keys(profilesData.profiles));
const DEFAULT_PROFILE =
  typeof profilesData.defaultProfile === "string" && ALLOWED_PROFILES.has(profilesData.defaultProfile)
    ? profilesData.defaultProfile
    : "pi_zero_2";

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

function asBool(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  return fallback;
}

export function resolveKioskConfig(input = {}) {
  const profileName =
    typeof input.profile === "string" && ALLOWED_PROFILES.has(input.profile)
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
