import $fullscreen from "common/fullscreen";
import { resolveKioskConfig, asBool } from "kiosk-config";

const config = window.__CONFIG__ || {};
const staticUri = config.staticUri || "/static";
const apiUri = config.apiUri || "/api/v1";
const contentUri = config.contentUri || apiUri;
const previewToken = () => window.__CONFIG__?.previewToken || config.previewToken || "public";
const DOUBLE_CLICK_MS = 400;
const SWIPE_MIN_PX = 48;
const BOTTOM_ROOT_MARGIN_PX = 80;
const LOAD_TIMEOUT_MS = 15000;

let resolvedKiosk = null;
let bottomLoadCheckPending = false;
let thumbPrefetchGeneration = 0;

const scrollState = {
  active: false,
  timer: null,
  loadPending: false,
  prunePending: false,
};

const gridMetrics = {
  rowHeight: 0,
  columnCount: 0,
};

let lastRightClickAt = 0;
let listenersBound = false;
let authToken = null;
let authTokenChecked = false;
let restorePending = false;
let prunePending = false;
let pruneCooldownUntil = 0;
let autoAdvanceOnLoad = false;
let kioskBootPending = true;
let backgroundFillTimer = null;
let gridImagesSuspended = false;

const state = {
  photos: [],
  offset: 0,
  loading: false,
  done: false,
  error: "",
  generation: 0,
  controller: null,
  bottomObserver: null,
  topObserver: null,
  previewIndex: -1,
  elements: {},
};

const gridWindow = {
  startIndex: 0,
  topSpacerPx: 0,
};

const slideshow = {
  active: false,
  paused: false,
  timer: null,
};

const slidePrefetch = {
  index: -1,
  url: "",
  image: null,
  timer: null,
};

const touch = {
  x: 0,
  y: 0,
};

export function pickHash(item) {
  if (typeof item?.Hash === "string" && item.Hash) {
    return item.Hash;
  }
  if (!Array.isArray(item?.Files)) {
    return "";
  }
  const primary = item.Files.find((f) => f?.Primary && f?.Hash);
  if (primary?.Hash) {
    return primary.Hash;
  }
  const fallback = item.Files.find((f) => !f?.Missing && f?.Hash);
  return fallback?.Hash || "";
}

export function mapPhoto(item) {
  const hash = pickHash(item);
  const title = item?.Title || item?.Name || item?.UID || "Photo";
  if (!hash) {
    return {
      title,
      hash: "",
      thumbSrc: `${staticUri}/img/404.jpg`,
      fullSrc: `${staticUri}/img/404.jpg`,
    };
  }
  return {
    title,
    hash,
    thumbSrc: thumbUrl(hash),
    fullSrc: previewUrl(hash),
  };
}

function thumbUrl(hash) {
  return `${contentUri}/t/${hash}/${previewToken()}/${getKiosk().thumbSize}`;
}

function photoThumbSrc(photo) {
  return photo.hash ? thumbUrl(photo.hash) : photo.thumbSrc;
}

function prefetchThumbUrls(urls) {
  const concurrency = getKiosk().thumbLoadConcurrency;
  if (!concurrency || urls.length === 0) {
    return;
  }
  const generation = ++thumbPrefetchGeneration;
  let next = 0;
  const runWorker = async () => {
    while (next < urls.length) {
      if (generation !== thumbPrefetchGeneration) {
        return;
      }
      const url = urls[next++];
      await new Promise((resolve) => {
        const img = new Image();
        img.decoding = "async";
        const finish = () => {
          img.onload = null;
          img.onerror = null;
          resolve();
        };
        img.onload = finish;
        img.onerror = finish;
        img.src = url;
      });
    }
  };
  const workers = Math.min(concurrency, urls.length);
  void Promise.all(Array.from({ length: workers }, runWorker)).catch((e) => console.error("Prefetch error:", e));
}

function assignThumbPriority(img, index) {
  if (index < 4) {
    img.fetchPriority = "high";
  } else if (index >= getKiosk().eagerThumbCount) {
    img.fetchPriority = "low";
  }
}

function getKioskConfig() {
  return window.__CONFIG__?.kioskConfig || config.kioskConfig || {};
}

function getKiosk() {
  if (!resolvedKiosk) {
    resolvedKiosk = resolveKioskConfig(getKioskConfig());
  }
  return resolvedKiosk;
}

function resetKioskConfig() {
  resolvedKiosk = null;
}

// Reads the raw (unresolved) config on purpose: an absent value must stay
// "off" when the app is served without the host's resolved kioskConfig.
// asBool from the shared resolver keeps string coercion ("true"/"1")
// identical to what the host applies.
function isAutoSlideshowEnabled() {
  return asBool(getKioskConfig().autoSlideshow, false);
}

function getPreviewSize() {
  return getKiosk().previewSize;
}

function previewUrl(hash) {
  return `${contentUri}/t/${hash}/${previewToken()}/${getPreviewSize()}`;
}

function applyPreviewTokenFromResponse(response) {
  const token = response.headers.get("x-preview-token");
  if (token && window.__CONFIG__) {
    window.__CONFIG__.previewToken = token;
  }
}

async function ensureRuntimeConfig() {
  try {
    const response = await fetch(`${apiUri.replace(/\/+$/, "")}/config`, {
      method: "GET",
      credentials: "same-origin",
      headers: apiHeaders(),
    });
    if (!response.ok) {
      return;
    }
    applyPreviewTokenFromResponse(response);
    const cfg = await response.json();
    if (cfg?.previewToken && window.__CONFIG__) {
      window.__CONFIG__.previewToken = cfg.previewToken;
    }
  } catch {
    // Fall back to boot-time __CONFIG__ defaults.
  }
}

function getAuthToken() {
  if (authTokenChecked) {
    return authToken || "";
  }
  authTokenChecked = true;
  try {
    const direct = localStorage.getItem("session.token");
    if (direct) {
      authToken = direct;
      return authToken;
    }
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.endsWith(":session.token")) {
        const value = localStorage.getItem(key);
        if (value) {
          authToken = value;
          return authToken;
        }
      }
    }
  } catch {
    authToken = "";
  }
  return authToken || "";
}

function apiHeaders() {
  const headers = { Accept: "application/json" };
  const token = getAuthToken();
  if (token) {
    headers["X-Auth-Token"] = token;
  }
  return headers;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text) {
    node.textContent = text;
  }
  return node;
}

// WPE WebKit under Cog often drops click on overlay controls; pointerup/touchend
// are more reliable on the Pi frame. Dedupe guards against double invocation.
function bindControlAction(node, handler) {
  let handled = false;
  const run = (ev) => {
    if (handled) {
      return;
    }
    if ("button" in ev && ev.button !== 0 && ev.type !== "touchend") {
      return;
    }
    handled = true;
    setTimeout(() => {
      handled = false;
    }, 400);
    ev.preventDefault();
    ev.stopPropagation();
    handler();
  };
  node.addEventListener("pointerdown", (ev) => {
    if (ev.button === 0) {
      node.dataset.pgPressed = "1";
    }
  });
  node.addEventListener("pointerup", (ev) => {
    if (node.dataset.pgPressed !== "1") {
      return;
    }
    delete node.dataset.pgPressed;
    run(ev);
  });
  node.addEventListener("pointercancel", () => {
    delete node.dataset.pgPressed;
  });
  node.addEventListener("touchend", run, { passive: false });
  node.addEventListener("click", run);
}

function setStatus(text) {
  state.elements.status.textContent = text || "";
}

function setError(text) {
  state.error = text || "";
  state.elements.error.textContent = state.error;
}

function isPreviewOpen() {
  return state.elements.overlay?.classList.contains("is-open") ?? false;
}

function openPhotoCard(index) {
  enterPreviewFromGrid(index);
}

// Marks the slideshow active from the caller's current slide; advancing is
// driven by state.previewIndex inside scheduleSlideshowTick().
function beginSlideshowAt() {
  slideshow.active = true;
  slideshow.paused = false;
  if (slideshow.timer) {
    clearTimeout(slideshow.timer);
    slideshow.timer = null;
  }
  state.elements.slideshowBtn?.classList.add("is-active");
  state.elements.slideshowBtn?.setAttribute("aria-pressed", "true");
  scheduleSlideshowTick();
  maybeScheduleBackgroundFill(true);
}

function enterPreviewFromGrid(index) {
  showPreviewAt(index);
  $fullscreen.request().catch(() => {});
  if (isAutoSlideshowEnabled()) {
    beginSlideshowAt();
  }
}

function toggleFullscreen() {
  if ($fullscreen.isEnabled()) {
    $fullscreen.exit().catch(() => {});
    if (slideshow.active) {
      pauseSlideshow();
    }
    return;
  }
  $fullscreen.request().catch(() => {});
  if (!isPreviewOpen()) {
    return;
  }
  if (slideshow.active && slideshow.paused) {
    resumeSlideshow();
    return;
  }
  if (isAutoSlideshowEnabled() && !slideshow.active) {
    beginSlideshowAt();
  }
}

function getColumnCount() {
  if (gridMetrics.columnCount > 0) {
    return gridMetrics.columnCount;
  }
  if (!state.elements.grid) {
    return 1;
  }
  const template = getComputedStyle(state.elements.grid).gridTemplateColumns;
  if (!template || template === "none") {
    return 1;
  }
  const cols = template.split(" ").filter(Boolean).length;
  if (cols > 0 && !isPreviewOpen()) {
    gridMetrics.columnCount = cols;
  }
  return cols || 1;
}

function measureRowHeight() {
  if (gridMetrics.rowHeight > 0) {
    return gridMetrics.rowHeight;
  }
  if (!state.elements.grid || isPreviewOpen()) {
    return 128;
  }
  const card = state.elements.grid.querySelector(".pg-card");
  if (!card) {
    return 128;
  }
  const rect = card.getBoundingClientRect();
  if (rect.height <= 0) {
    return 128;
  }
  const gap = parseFloat(getComputedStyle(state.elements.grid).rowGap) || 8;
  gridMetrics.rowHeight = rect.height + gap;
  return gridMetrics.rowHeight;
}

function updateTopSpacer() {
  if (!state.elements.topSpacer) {
    return;
  }
  state.elements.topSpacer.style.height = `${gridWindow.topSpacerPx}px`;
}

function resetGridWindow() {
  gridWindow.startIndex = 0;
  gridWindow.topSpacerPx = 0;
  updateTopSpacer();
}

function createPhotoCard(photo, index) {
  const card = el("button", "pg-card");
  card.type = "button";
  card.title = photo.title;
  card.dataset.photoIndex = String(index);
  bindControlAction(card, () => openPhotoCard(index));

  const img = el("img", "pg-image");
  img.alt = photo.title;
  img.decoding = "async";
  // The grid is a capped virtual window (~maxGridRows); lazy + content-visibility
  // made WPE load thumbs one-by-one as each card entered view.
  img.loading = "eager";
  if (gridImagesSuspended) {
    img.dataset.pgSavedSrc = photoThumbSrc(photo);
  } else {
    img.src = photoThumbSrc(photo);
  }
  assignThumbPriority(img, index);
  card.appendChild(img);
  return card;
}

function insertPhotoCards(photos, startIndex, atEnd) {
  const frag = document.createDocumentFragment();
  photos.forEach((photo, offset) => {
    frag.appendChild(createPhotoCard(photo, startIndex + offset));
  });
  if (atEnd) {
    state.elements.grid.appendChild(frag);
  } else {
    const firstCard = state.elements.grid.querySelector(".pg-card");
    if (firstCard) {
      state.elements.grid.insertBefore(frag, firstCard);
    } else {
      state.elements.topSentinel.after(frag);
    }
  }
  if (gridImagesSuspended) {
    prefetchThumbUrls(photos.map(photoThumbSrc));
  }
}

function removeCardNode(card) {
  card.querySelectorAll("img").forEach((img) => {
    img.removeAttribute("src");
    img.src = "";
  });
  card.remove();
}

function pruneTopRowsIfNeeded() {
  const grid = state.elements.grid;
  const ncol = getColumnCount();
  const maxCards = getKiosk().maxGridRows * ncol;
  const cardNodes = grid.querySelectorAll(".pg-card");
  const cardCount = cardNodes.length;
  if (cardCount <= maxCards) {
    return;
  }

  const excess = cardCount - maxCards;
  const rowsToRemove = Math.ceil(excess / ncol);
  const removeCount = rowsToRemove * ncol;
  const rowHeight = measureRowHeight();

  for (let i = 0; i < removeCount; i += 1) {
    const card = cardNodes[i];
    if (!card) {
      break;
    }
    removeCardNode(card);
  }

  gridWindow.startIndex += removeCount;
  const spacerDelta = rowsToRemove * rowHeight;
  gridWindow.topSpacerPx += spacerDelta;
  updateTopSpacer();
  pruneCooldownUntil = Date.now() + getKiosk().pruneCooldownMs;
}

function pruneBottomRowsIfNeeded() {
  const grid = state.elements.grid;
  const ncol = getColumnCount();
  const maxCards = getKiosk().maxGridRows * ncol;
  const cardNodes = grid.querySelectorAll(".pg-card");
  const cardCount = cardNodes.length;
  if (cardCount <= maxCards) {
    return;
  }
  const excess = cardCount - maxCards;
  const rowsToRemove = Math.ceil(excess / ncol);
  const removeCount = rowsToRemove * ncol;
  for (let i = 0; i < removeCount; i += 1) {
    const card = cardNodes[cardCount - 1 - i];
    if (card) removeCardNode(card);
  }
}

function runPruneTopRows() {
  if (prunePending) {
    return;
  }
  prunePending = true;
  requestAnimationFrame(() => {
    prunePending = false;
    pruneTopRowsIfNeeded();
  });
}

function schedulePruneTopRows() {
  if (scrollState.active) {
    scrollState.prunePending = true;
    return;
  }
  runPruneTopRows();
}

function restoreTopRowsIfNeeded() {
  if (gridWindow.startIndex <= 0) {
    return;
  }
  const ncol = getColumnCount();
  const restoreCount = Math.min(ncol * getKiosk().restoreRowBatch, gridWindow.startIndex);
  const start = gridWindow.startIndex - restoreCount;
  const rowHeight = measureRowHeight();
  const rowsRestored = Math.ceil(restoreCount / ncol);
  insertPhotoCards(state.photos.slice(start, gridWindow.startIndex), start, false);
  gridWindow.startIndex = start;
  if (gridWindow.startIndex <= 0) {
    gridWindow.startIndex = 0;
    gridWindow.topSpacerPx = 0;
  } else {
    gridWindow.topSpacerPx = Math.max(0, gridWindow.topSpacerPx - rowsRestored * rowHeight);
  }
  updateTopSpacer();
  pruneBottomRowsIfNeeded();
}

function scheduleRestoreTopRows() {
  if (restorePending || gridWindow.startIndex <= 0 || isPreviewOpen()) {
    return;
  }
  const remainingCooldown = pruneCooldownUntil - Date.now();
  if (remainingCooldown > 0) {
    setTimeout(scheduleRestoreTopRows, remainingCooldown + 10);
    return;
  }
  if (window.scrollY > gridWindow.topSpacerPx + 250) {
    return;
  }
  restorePending = true;
  requestAnimationFrame(() => {
    restorePending = false;
    restoreTopRowsIfNeeded();
  });
}

function stopSlideshow() {
  slideshow.active = false;
  slideshow.paused = false;
  if (slideshow.timer) {
    clearTimeout(slideshow.timer);
    slideshow.timer = null;
  }
  cancelBackgroundFill();
  state.elements.slideshowBtn?.classList.remove("is-active");
  state.elements.slideshowBtn?.setAttribute("aria-pressed", "false");
}

function pauseSlideshow() {
  if (!slideshow.active || slideshow.paused) {
    return;
  }
  slideshow.paused = true;
  if (slideshow.timer) {
    clearTimeout(slideshow.timer);
    slideshow.timer = null;
  }
}

function resumeSlideshow() {
  if (!slideshow.active || !slideshow.paused) {
    return;
  }
  slideshow.paused = false;
  scheduleSlideshowTick();
}

function toggleSlideshowPause() {
  if (!slideshow.active) {
    return;
  }
  if (slideshow.paused) {
    resumeSlideshow();
  } else {
    pauseSlideshow();
  }
}

function getSlideshowWait() {
  return getKiosk().slideDuration * 1000;
}

function scheduleSlideshowTick() {
  if (slideshow.timer) {
    clearTimeout(slideshow.timer);
    slideshow.timer = null;
  }
  if (!slideshow.active || slideshow.paused) {
    return;
  }

  slideshow.timer = setTimeout(() => {
    slideshow.timer = null;
    if (!slideshow.active || slideshow.paused) {
      return;
    }

    let next = state.previewIndex;
    if (next < 0) {
      next = 0;
    } else {
      next += 1;
    }

    if (next >= state.photos.length) {
      if (state.done) {
        next = 0;
      } else {
        autoAdvanceOnLoad = true;
        loadMore();
        scheduleSlideshowTick();
        return;
      }
    }

    showPreviewAt(next, { fromSlideshow: true });
    scheduleSlideshowTick();
  }, getSlideshowWait());
}

function startSlideshow() {
  if (slideshow.active) {
    return;
  }
  const index = state.previewIndex >= 0 ? state.previewIndex : 0;
  if (!isPreviewOpen() && state.photos.length > 0) {
    showPreviewAt(index);
    $fullscreen.request().catch(() => {});
  }
  beginSlideshowAt();
}

function toggleSlideshow() {
  if (slideshow.active) {
    closePreview();
  } else {
    startSlideshow();
  }
}

function suspendGridImages() {
  if (gridImagesSuspended || !state.elements.grid || !getKiosk().suspendGridInPreview) {
    return;
  }
  gridImagesSuspended = true;
  cancelBackgroundFill();
  state.elements.shell?.classList.add("is-suspended");
  state.elements.grid.querySelectorAll(".pg-image").forEach((img) => {
    if (img.src) {
      img.dataset.pgSavedSrc = img.src;
      img.removeAttribute("src");
      img.src = "";
    }
  });
}

function resumeGridImages() {
  if (!gridImagesSuspended || !state.elements.grid) {
    return;
  }
  gridImagesSuspended = false;
  state.elements.shell?.classList.remove("is-suspended");
  state.elements.grid.querySelectorAll(".pg-image").forEach((img) => {
    const saved = img.dataset.pgSavedSrc;
    if (saved) {
      img.src = saved;
      delete img.dataset.pgSavedSrc;
    }
  });
}

function closePreview() {
  const lastIndex = state.previewIndex;
  state.previewIndex = -1;
  state.elements.overlay?.classList.remove("is-open");
  cancelSlidePrefetch();
  if (state.elements.preview) {
    state.elements.preview.removeAttribute("src");
    state.elements.preview.src = "";
  }
  document.documentElement.classList.remove("pg-preview-open");
  // Restore thumbnails first — resumeGridImages() is a no-op once the
  // suspended flag is cleared — then force-clear the suspension state so the
  // grid stays interactive even if the flag and shell class drifted apart
  // (e.g. suspendGridInPreview was false when this preview opened).
  resumeGridImages();
  gridImagesSuspended = false;
  state.elements.shell?.classList.remove("is-suspended");
  stopSlideshow();
  updatePreviewMeta();
  scheduleBottomLoadCheck();
  renderState();
  $fullscreen.exit().catch(() => {});
  if (lastIndex >= 0 && state.elements.grid) {
    const targetCard = state.elements.grid.querySelector(`.pg-card[data-photo-index="${lastIndex}"]`);
    targetCard?.focus?.({ preventScroll: true });
  }
}

function cancelSlidePrefetch() {
  if (slidePrefetch.timer) {
    clearTimeout(slidePrefetch.timer);
    slidePrefetch.timer = null;
  }
  if (slidePrefetch.image) {
    slidePrefetch.image.onload = null;
    slidePrefetch.image.onerror = null;
    slidePrefetch.image.src = "";
    slidePrefetch.image = null;
  }
  slidePrefetch.index = -1;
  slidePrefetch.url = "";
}

function prefetchSlideAt(index) {
  if (index < 0 || index >= state.photos.length) {
    return;
  }
  const photo = state.photos[index];
  const url = photo.hash ? previewUrl(photo.hash) : photo.fullSrc;
  if (!url || slidePrefetch.index === index) {
    return;
  }
  cancelSlidePrefetch();
  slidePrefetch.index = index;
  slidePrefetch.url = url;
  // Debounce rapid keyboard/swipe navigation so stale full-size requests do not
  // compete with the currently visible slide on constrained Wi-Fi/WPE devices.
  slidePrefetch.timer = setTimeout(() => {
    slidePrefetch.timer = null;
    if (slidePrefetch.index !== index || slidePrefetch.url !== url) {
      return;
    }
    const img = new Image();
    img.decoding = "async";
    img.fetchPriority = "low";
    slidePrefetch.image = img;
    img.src = url;
  }, 150);
}

function scheduleSlidePrefetch() {
  if (!getKiosk().prefetchNextSlide) {
    return;
  }
  if (!isPreviewOpen() || state.previewIndex < 0) {
    return;
  }
  let next = state.previewIndex + 1;
  if (next >= state.photos.length) {
    if (state.done && state.photos.length > 0) {
      next = 0;
    } else {
      return;
    }
  }
  prefetchSlideAt(next);
}

function updatePreviewMeta() {
  const total = state.photos.length;
  const idx = state.previewIndex;
  if (state.elements.counter) {
    const suffix = state.done ? "" : "+";
    state.elements.counter.textContent = total > 0 && idx >= 0 ? `${idx + 1} / ${total}${suffix}` : "";
  }
  if (state.elements.caption) {
    const photo = idx >= 0 ? state.photos[idx] : null;
    state.elements.caption.textContent = photo?.title || "";
  }
}

function showPreviewAt(index, options = {}) {
  if (index < 0 || index >= state.photos.length) {
    return;
  }
  const photo = state.photos[index];
  const src = photo.hash ? previewUrl(photo.hash) : photo.fullSrc;
  // Compare the raw attribute: the .src property resolves to an absolute URL
  // and would never equal the relative content URL (dead guard otherwise).
  const sameSlide = state.previewIndex === index && state.elements.preview?.getAttribute("src") === src;

  state.previewIndex = index;
  if (!sameSlide) {
    state.elements.preview.src = src;
    state.elements.preview.alt = photo.title;
  }
  state.elements.overlay.classList.add("is-open");
  document.documentElement.classList.add("pg-preview-open");
  suspendGridImages();
  updatePreviewMeta();
  if (!options.fromSlideshow) {
    state.elements.overlay.focus({ preventScroll: true });
  }
  scheduleSlidePrefetch();

  if (
    !slideshow.active &&
    index >= state.photos.length - 4 &&
    !state.done &&
    !state.loading
  ) {
    loadMore();
  } else if (
    slideshow.active &&
    index >= state.photos.length - 2 &&
    !state.done &&
    !state.loading
  ) {
    setTimeout(() => {
      if (slideshow.active && !state.loading && !state.done) {
        loadMore();
      }
    }, 250);
  }
}

function previewNext() {
  if (state.previewIndex < state.photos.length - 1) {
    showPreviewAt(state.previewIndex + 1);
    if (slideshow.active) {
      scheduleSlideshowTick();
    }
  } else if (!state.done) {
    if (!state.loading) {
      autoAdvanceOnLoad = true;
      loadMore();
    }
  }
}

function previewPrev() {
  if (state.previewIndex > 0) {
    showPreviewAt(state.previewIndex - 1);
    if (slideshow.active) {
      scheduleSlideshowTick();
    }
  }
}

function completeAutoAdvanceIfNeeded(loadedOk) {
  if (!loadedOk || !autoAdvanceOnLoad) {
    return;
  }
  autoAdvanceOnLoad = false;
  const nextIndex = state.previewIndex + 1;
  if (nextIndex < state.photos.length) {
    showPreviewAt(nextIndex, { fromSlideshow: true });
    if (slideshow.active) {
      scheduleSlideshowTick();
    }
  } else if (slideshow.active) {
    scheduleSlideshowTick();
  }
}

function invalidateGridMetrics() {
  gridMetrics.rowHeight = 0;
  gridMetrics.columnCount = 0;
}

function markScrolling() {
  scrollState.active = true;
  if (scrollState.timer) {
    clearTimeout(scrollState.timer);
  }
  scrollState.timer = setTimeout(() => {
    scrollState.timer = null;
    scrollState.active = false;
    if (scrollState.loadPending) {
      scrollState.loadPending = false;
      requestLoadMore();
    }
    if (scrollState.prunePending) {
      scrollState.prunePending = false;
      runPruneTopRows();
    }
    if (gridWindow.startIndex > 0 && window.scrollY <= gridWindow.topSpacerPx + 250) {
      scheduleRestoreTopRows();
    }
    scheduleBottomLoadCheck();
  }, getKiosk().scrollIdleMs);
}

function advanceGridOrLoadMore() {
  if (isPreviewOpen()) {
    return;
  }
  const grid = state.elements.grid;
  if (!grid) {
    return;
  }
  const cardNodes = grid.querySelectorAll(".pg-card");
  const currentEnd = gridWindow.startIndex + cardNodes.length;
  if (currentEnd < state.photos.length) {
    const ncol = getColumnCount();
    const batch = Math.min(ncol * getKiosk().restoreRowBatch, state.photos.length - currentEnd);
    const photosToInsert = state.photos.slice(currentEnd, currentEnd + batch);
    insertPhotoCards(photosToInsert, currentEnd, true);
    schedulePruneTopRows();
    scheduleBottomLoadCheck();
    return;
  }
  if (!state.loading && !state.done) {
    loadMore();
  }
}

function requestLoadMore() {
  if (state.loading || isPreviewOpen()) {
    return;
  }
  const grid = state.elements.grid;
  const cardNodes = grid ? grid.querySelectorAll(".pg-card") : [];
  const currentEnd = gridWindow.startIndex + cardNodes.length;
  if (state.done && currentEnd >= state.photos.length) {
    return;
  }
  if (scrollState.active) {
    scrollState.loadPending = true;
    return;
  }
  advanceGridOrLoadMore();
}

function isBottomSentinelNearViewport() {
  const sentinel = state.elements.sentinel;
  if (!sentinel) {
    return false;
  }
  const rect = sentinel.getBoundingClientRect();
  return rect.top <= window.innerHeight + BOTTOM_ROOT_MARGIN_PX;
}

function refreshBottomObserver() {
  if (!state.bottomObserver || !state.elements.sentinel) {
    return;
  }
  state.bottomObserver.unobserve(state.elements.sentinel);
  state.bottomObserver.observe(state.elements.sentinel);
}

function ensureMoreIfBottomVisible() {
  if (state.loading || isPreviewOpen()) {
    return;
  }
  const grid = state.elements.grid;
  const cardNodes = grid ? grid.querySelectorAll(".pg-card") : [];
  const currentEnd = gridWindow.startIndex + cardNodes.length;
  if (state.done && currentEnd >= state.photos.length) {
    return;
  }
  if (isBottomSentinelNearViewport()) {
    requestLoadMore();
  }
}

function scheduleBottomLoadCheck() {
  if (bottomLoadCheckPending) {
    return;
  }
  bottomLoadCheckPending = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      bottomLoadCheckPending = false;
      refreshBottomObserver();
      ensureMoreIfBottomVisible();
    });
  });
}

function maybeStartKioskSlideshow() {
  if (!kioskBootPending || state.photos.length === 0) {
    return;
  }
  if (!isAutoSlideshowEnabled()) {
    return;
  }
  kioskBootPending = false;
  startSlideshow();
}

function cancelBackgroundFill() {
  if (backgroundFillTimer) {
    clearTimeout(backgroundFillTimer);
    backgroundFillTimer = null;
  }
}

function maybeScheduleBackgroundFill(loadedOk = true) {
  if (!slideshow.active) {
    cancelBackgroundFill();
    return;
  }
  const fillTarget = getKiosk().backgroundFillTarget;
  if (fillTarget <= 0 || state.done || state.photos.length >= fillTarget) {
    cancelBackgroundFill();
    return;
  }
  if (backgroundFillTimer || state.loading || scrollState.active) {
    return;
  }
  if (!loadedOk) {
    return;
  }

  backgroundFillTimer = setTimeout(() => {
    backgroundFillTimer = null;
    if (
      slideshow.active &&
      !state.loading &&
      !state.done &&
      !scrollState.active &&
      state.photos.length < fillTarget
    ) {
      loadMore();
    }
  }, getKiosk().backgroundFillDelayMs);
}

function appendPhotos(rows) {
  const baseIndex = state.photos.length;
  state.photos.push(...rows);
  const grid = state.elements.grid;
  const cardNodes = grid ? grid.querySelectorAll(".pg-card") : [];
  const currentEnd = gridWindow.startIndex + cardNodes.length;
  if (currentEnd === baseIndex) {
    insertPhotoCards(rows, baseIndex, true);
    schedulePruneTopRows();
  }
}

function renderState() {
  state.elements.shell?.classList.toggle("is-loading", state.loading);

  if (isPreviewOpen()) {
    updatePreviewMeta();
    return;
  }

  if (state.loading) {
    const count = state.photos.length;
    setStatus(count > 0 ? `Loading… (${count})` : "Loading…");
  } else if (state.done && state.photos.length > 0) {
    setStatus(`${state.photos.length} photos`);
  } else if (state.photos.length > 0) {
    setStatus(`${state.photos.length} photos loaded`);
  } else {
    setStatus("");
  }
}

function pageBatchSize() {
  return state.offset === 0 ? getKiosk().firstPageSize : getKiosk().pageSize;
}

async function loadMore() {
  if (state.loading || state.done) {
    return;
  }
  state.loading = true;
  setError("");
  renderState();

  const generation = state.generation;
  const controller = new AbortController();
  state.controller = controller;
  const batchSize = pageBatchSize();
  let loadedOk = false;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, LOAD_TIMEOUT_MS);

  try {
    const url = new URL(`${apiUri.replace(/\/+$/, "")}/photos`, window.location.origin);
    url.searchParams.set("count", String(batchSize));
    url.searchParams.set("offset", String(state.offset));
    url.searchParams.set("merged", "true");
    url.searchParams.set("quality", "0");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: apiHeaders(),
      credentials: "same-origin",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    applyPreviewTokenFromResponse(response);

    const data = await response.json();
    if (generation !== state.generation) {
      autoAdvanceOnLoad = false;
      return;
    }

    const rows = Array.isArray(data) ? data.map(mapPhoto) : [];
    state.offset += rows.length;
    appendPhotos(rows);

    if (rows.length < batchSize) {
      state.done = true;
    }
    loadedOk = true;
  } catch (err) {
    autoAdvanceOnLoad = false;
    if (timedOut) {
      setError("Network timeout - retrying when you scroll.");
    } else if (err?.name !== "AbortError") {
      setError("Failed to load photos.");
    }
  } finally {
    clearTimeout(timeout);
    // A reset (Reload) bumps the generation and aborts this request. Guard the
    // shared runtime flags so a stale load's finally cannot clear state.loading
    // out from under the fresh load and let a duplicate load start concurrently.
    if (generation === state.generation) {
      if (state.controller === controller) {
        state.controller = null;
      }
      state.loading = false;
      renderState();
      completeAutoAdvanceIfNeeded(loadedOk);
      maybeStartKioskSlideshow();
      maybeScheduleBackgroundFill(loadedOk);
      if (
        slideshow.active &&
        isPreviewOpen() &&
        state.previewIndex >= state.photos.length - 1 &&
        loadedOk &&
        !autoAdvanceOnLoad
      ) {
        scheduleSlideshowTick();
      }
      scheduleBottomLoadCheck();
    }
  }
}

function resetRuntimeState() {
  state.generation += 1;
  if (state.controller) {
    state.controller.abort();
    state.controller = null;
  }
  state.photos = [];
  state.offset = 0;
  state.loading = false;
  state.done = false;
  state.error = "";
  state.previewIndex = -1;
  authTokenChecked = false;
  authToken = null;
  restorePending = false;
  prunePending = false;
  pruneCooldownUntil = 0;
  scrollState.active = false;
  scrollState.loadPending = false;
  scrollState.prunePending = false;
  if (scrollState.timer) {
    clearTimeout(scrollState.timer);
    scrollState.timer = null;
  }
  bottomLoadCheckPending = false;
  thumbPrefetchGeneration += 1;
  invalidateGridMetrics();
  autoAdvanceOnLoad = false;
  kioskBootPending = true;
  resetKioskConfig();
  cancelBackgroundFill();
  cancelSlidePrefetch();
  gridImagesSuspended = false;
  stopSlideshow();
  resetGridWindow();
  if (state.topObserver) {
    state.topObserver.disconnect();
    state.topObserver = null;
  }
  if (state.bottomObserver) {
    state.bottomObserver.disconnect();
    state.bottomObserver = null;
  }
}

function resetAndReload() {
  window.scrollTo(0, 0);
  resetRuntimeState();
  kioskBootPending = false;
  if (state.elements.grid) {
    state.elements.grid.querySelectorAll(".pg-card").forEach(removeCardNode);
  }
  closePreview();
  setError("");
  renderState();
  // resetRuntimeState() disconnected the scroll observers; re-arm them so the
  // Reload button does not permanently break infinite scroll / top restore.
  setupInfiniteObservers();
  loadMore();
}

function onKeyDown(ev) {
  if (ev.key === "Escape") {
    if (isPreviewOpen()) {
      closePreview();
    } else if ($fullscreen.isEnabled()) {
      $fullscreen.exit().catch(() => {});
    }
    return;
  }

  if (ev.key === "f" || ev.key === "F") {
    ev.preventDefault();
    toggleFullscreen();
    return;
  }

  if (ev.key === "s" || ev.key === "S") {
    ev.preventDefault();
    toggleSlideshow();
    return;
  }

  if (!isPreviewOpen()) {
    if (ev.key === "Enter" || ev.key === " " || ev.key === "Spacebar") {
      const focused = document.activeElement;
      if (focused?.classList?.contains("pg-card")) {
        const index = Number(focused.dataset.photoIndex);
        if (Number.isFinite(index)) {
          ev.preventDefault();
          openPhotoCard(index);
        }
      }
    }
    return;
  }

  if (ev.key === "ArrowRight") {
    ev.preventDefault();
    previewNext();
  } else if (ev.key === "ArrowLeft") {
    ev.preventDefault();
    previewPrev();
  } else if (ev.key === " " || ev.key === "Spacebar") {
    ev.preventDefault();
    toggleSlideshowPause();
  }
}

function onAuxClick(ev) {
  if (ev.button !== 1) {
    return;
  }
  ev.preventDefault();
  toggleFullscreen();
}

function onContextMenu(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  const now = Date.now();
  if (now - lastRightClickAt <= DOUBLE_CLICK_MS) {
    lastRightClickAt = 0;
    toggleFullscreen();
    return;
  }
  lastRightClickAt = now;
  if (slideshow.active && !slideshow.paused) {
    pauseSlideshow();
  }
}

let touchSwiped = false;

function onTouchStart(ev) {
  if (!isPreviewOpen() || !ev.changedTouches?.length) {
    return;
  }
  touchSwiped = false;
  const t = ev.changedTouches[0];
  touch.x = t.clientX;
  touch.y = t.clientY;
}

function onTouchEnd(ev) {
  if (!isPreviewOpen() || !ev.changedTouches?.length) {
    return;
  }
  const t = ev.changedTouches[0];
  const dx = t.clientX - touch.x;
  const dy = t.clientY - touch.y;
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy)) {
    return;
  }
  touchSwiped = true;
  if (dx < 0) {
    previewNext();
  } else {
    previewPrev();
  }
}

function clearBootSplash() {
  document.body?.classList.remove("nojs");
  document.documentElement?.classList.remove("loading");
  document.getElementById("photoprism")?.remove();
  document.getElementById("busy-overlay")?.remove();
}

function buildUi(root) {
  state.elements.overlay?.remove();
  document.querySelector(".pg-overlay")?.remove();
  root.textContent = "";
  const shell = el("main", "pg-shell");
  const header = el("header", "pg-header");
  const title = el("h1", "pg-title", "Photos");
  const actions = el("div", "pg-actions");

  const slideshowBtn = el("button", "pg-button pg-slideshow", "Slideshow");
  slideshowBtn.type = "button";
  slideshowBtn.setAttribute("aria-pressed", "false");
  slideshowBtn.addEventListener("click", toggleSlideshow, { passive: true });

  const reload = el("button", "pg-button", "Reload");
  reload.type = "button";
  reload.addEventListener("click", resetAndReload, { passive: true });

  actions.append(slideshowBtn, reload);
  header.append(title, actions);

  const error = el("p", "pg-error");
  const grid = el("section", "pg-grid");
  const topSpacer = el("div", "pg-top-spacer");
  const topSentinel = el("div", "pg-top-sentinel");
  grid.append(topSpacer, topSentinel);

  const sentinel = el("div", "pg-sentinel");
  const status = el("p", "pg-status");
  const overlay = el("div", "pg-overlay");
  overlay.tabIndex = -1;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Photo preview");
  const preview = el("img", "pg-preview");
  preview.decoding = "async";
  preview.loading = "eager";
  overlay.addEventListener("touchstart", onTouchStart, { passive: true });
  overlay.addEventListener("touchend", onTouchEnd, { passive: true });

  const chrome = el("div", "pg-overlay-chrome");
  const prevBtn = el("button", "pg-nav pg-nav-prev", "‹");
  prevBtn.type = "button";
  prevBtn.setAttribute("aria-label", "Previous photo");
  bindControlAction(prevBtn, previewPrev);

  const nextBtn = el("button", "pg-nav pg-nav-next", "›");
  nextBtn.type = "button";
  nextBtn.setAttribute("aria-label", "Next photo");
  bindControlAction(nextBtn, previewNext);

  const counter = el("div", "pg-overlay-counter");
  const caption = el("div", "pg-overlay-caption");
  const close = el("button", "pg-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "Close preview");
  bindControlAction(close, closePreview);

  chrome.append(prevBtn, nextBtn, counter, caption, close);
  overlay.append(preview, chrome);
  overlay.addEventListener("pointerup", (ev) => {
    if (touchSwiped) {
      touchSwiped = false;
      return;
    }
    if (ev.target === overlay) {
      closePreview();
    }
  });

  shell.append(header, error, grid, sentinel, status);
  root.appendChild(shell);
  document.body.appendChild(overlay);

  state.elements = {
    shell,
    error,
    topSentinel,
    grid,
    topSpacer,
    sentinel,
    status,
    overlay,
    preview,
    prevBtn,
    nextBtn,
    counter,
    caption,
    close,
    slideshowBtn,
  };
}

function bindListeners() {
  if (listenersBound) {
    return;
  }
  listenersBound = true;
  document.addEventListener("keydown", onKeyDown, { capture: true });
  document.addEventListener("contextmenu", onContextMenu, { capture: true });
  document.addEventListener("auxclick", onAuxClick, { capture: true });
  window.addEventListener("scroll", markScrolling, { passive: true });
  window.addEventListener(
    "resize",
    () => {
      invalidateGridMetrics();
    },
    { passive: true }
  );
}

// (Re)creates the top/bottom scroll observers against the current sentinels.
// Safe to call more than once: any existing observers are disconnected first.
function setupInfiniteObservers() {
  if (state.topObserver) {
    state.topObserver.disconnect();
  }
  state.topObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        scheduleRestoreTopRows();
      }
    },
    { rootMargin: "40px 0px 0px 0px" }
  );
  state.topObserver.observe(state.elements.topSentinel);

  if (state.bottomObserver) {
    state.bottomObserver.disconnect();
  }
  state.bottomObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        requestLoadMore();
      }
    },
    { rootMargin: `0px 0px ${BOTTOM_ROOT_MARGIN_PX}px 0px` }
  );
  state.bottomObserver.observe(state.elements.sentinel);
}

export async function bootMinimalPhotoApp(root) {
  if (!root) {
    return;
  }
  await ensureRuntimeConfig();
  clearBootSplash();
  resetKioskConfig();
  $fullscreen.setVirtualOnly(getKiosk().virtualFullscreenOnly);
  resetRuntimeState();
  buildUi(root);
  bindListeners();
  setupInfiniteObservers();
  await loadMore();
}
