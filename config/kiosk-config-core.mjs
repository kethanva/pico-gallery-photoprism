// Shared kiosk configuration resolver.
//
// Consumed by BOTH runtimes:
//   - Browser UI:  frontend/src/kiosk-config.js (webpack bundles this file)
//   - Node host:   scripts/kiosk-config.mjs (plain ESM import)
//
// Keep this file dependency-free and side-effect-free: callers supply the
// profile data, so clamp bounds, allowed sizes, and coercion rules can never
// drift between the client and the host.

const ALLOWED_PREVIEW_SIZES = new Set(["fit_720", "fit_1280"]);
const ALLOWED_THUMB_SIZES = new Set(["fit_720"]);
const FALLBACK_PROFILE = "pi_zero_2";

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function asBool(value, fallback) {
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

export function resolveKioskConfigFrom(profilesData, input = {}) {
  const profiles = profilesData && typeof profilesData === "object" ? profilesData.profiles : null;
  if (!profiles || typeof profiles !== "object" || Object.keys(profiles).length === 0) {
    throw new Error("kiosk-config: profile data contains no profiles");
  }
  const allowedProfiles = new Set(Object.keys(profiles));
  const defaultProfile =
    typeof profilesData.defaultProfile === "string" && allowedProfiles.has(profilesData.defaultProfile)
      ? profilesData.defaultProfile
      : FALLBACK_PROFILE;
  const profileName =
    typeof input.profile === "string" && allowedProfiles.has(input.profile) ? input.profile : defaultProfile;
  // A kiosk must boot even if defaultProfile is invalid: fall back to any profile.
  const base = profiles[profileName] || profiles[defaultProfile] || profiles[Object.keys(profiles)[0]];
  const merged = { ...base, ...input, profile: profileName };

  const previewSize = ALLOWED_PREVIEW_SIZES.has(merged.previewSize) ? merged.previewSize : base.previewSize;
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
