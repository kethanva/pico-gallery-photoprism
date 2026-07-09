import $fullscreen from "common/fullscreen";

const config = window.__CONFIG__ || {};
const staticUri = config.staticUri || "/static";
const apiUri = config.apiUri || "/api/v1";
const contentUri = config.contentUri || apiUri;
const previewToken = () => window.__CONFIG__?.previewToken || config.previewToken || "public";
const thumbSize = "fit_720";
const fullSize = "fit_1280";
const firstPageSize = 16;
const pageSize = 24;
const DOUBLE_CLICK_MS = 400;
const SWIPE_MIN_PX = 48;
const maxGridRows = 20;
const restoreRowBatch = 2;
const eagerThumbCount = 8;
const backgroundFillTarget = 400;
const backgroundFillDelayMs = 600;

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

const touch = {
  x: 0,
  y: 0,
};

let lastRightClickAt = 0;
let listenersBound = false;
let authToken = null;
let authTokenChecked = false;
let restorePending = false;
let prunePending = false;
let autoAdvanceOnLoad = false;
let kioskBootPending = true;
let backgroundFillTimer = null;

export function pickHash(item) {
  if (typeof item?.Hash === "string" && item.Hash) return item.Hash;
  if (!Array.isArray(item?.Files)) return "";
  const primary = item.Files.find((f) => f?.Primary && f?.Hash);
  if (primary?.Hash) return primary.Hash;
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
    fullSrc: fullUrl(hash),
  };
}

function thumbUrl(hash) {
  return `${contentUri}/t/${hash}/${previewToken()}/${thumbSize}`;
}

function fullUrl(hash) {
  return `${contentUri}/t/${hash}/${previewToken()}/${fullSize}`;
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
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return;
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
  if (authTokenChecked) return authToken || "";
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
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// WPE WebKit under Cog often drops click on overlay controls; pointerup/touchend
// are more reliable on the Pi frame. Dedupe guards against double invocation.
function bindControlAction(node, handler) {
  let handled = false;
  const run = (ev) => {
    if (handled) return;
    if ("button" in ev && ev.button !== 0 && ev.type !== "touchend") return;
    handled = true;
    setTimeout(() => {
      handled = false;
    }, 400);
    ev.preventDefault();
    ev.stopPropagation();
    handler();
  };
  node.addEventListener("pointerdown", (ev) => {
    if (ev.button === 0) node.dataset.pgPressed = "1";
  });
  node.addEventListener("pointerup", (ev) => {
    if (node.dataset.pgPressed !== "1") return;
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
  return state.elements.overlay.classList.contains("is-open");
}

function getColumnCount() {
  const template = getComputedStyle(state.elements.grid).gridTemplateColumns;
  if (!template || template === "none") return 1;
  return template.split(" ").filter(Boolean).length;
}

function measureRowHeight() {
  const card = state.elements.grid.querySelector(".pg-card");
  if (!card) return 128;
  const gap = parseFloat(getComputedStyle(state.elements.grid).rowGap) || 8;
  return card.getBoundingClientRect().height + gap;
}

function updateTopSpacer() {
  if (!state.elements.topSpacer) return;
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
  card.addEventListener(
    "click",
    () => {
      showPreviewAt(index);
      $fullscreen.request().catch(() => {});
    },
    { passive: true }
  );

  const img = el("img", "pg-image");
  img.alt = photo.title;
  img.decoding = "async";
  img.loading = "lazy";
  img.src = photo.hash ? thumbUrl(photo.hash) : photo.thumbSrc;
  if (index >= eagerThumbCount) {
    img.fetchPriority = "low";
  }
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
    return;
  }
  const firstCard = state.elements.grid.querySelector(".pg-card");
  if (firstCard) {
    state.elements.grid.insertBefore(frag, firstCard);
  } else {
    state.elements.topSentinel.after(frag);
  }
}

function removeCardNode(card) {
  card.remove();
}

function pruneTopRowsIfNeeded() {
  const grid = state.elements.grid;
  const ncol = getColumnCount();
  const maxCards = maxGridRows * ncol;
  const cardNodes = grid.querySelectorAll(".pg-card");
  const cardCount = cardNodes.length;
  if (cardCount <= maxCards) return;

  const excess = cardCount - maxCards;
  const rowsToRemove = Math.ceil(excess / ncol);
  const removeCount = rowsToRemove * ncol;
  const rowHeight = measureRowHeight();

  for (let i = 0; i < removeCount; i += 1) {
    const card = cardNodes[i];
    if (!card) break;
    removeCardNode(card);
  }

  gridWindow.startIndex += removeCount;
  const spacerDelta = rowsToRemove * rowHeight;
  gridWindow.topSpacerPx += spacerDelta;
  updateTopSpacer();
  window.scrollBy(0, -spacerDelta);
}

function schedulePruneTopRows() {
  if (prunePending) return;
  prunePending = true;
  requestAnimationFrame(() => {
    prunePending = false;
    pruneTopRowsIfNeeded();
  });
}

function restoreTopRowsIfNeeded() {
  if (gridWindow.startIndex <= 0) return;
  const ncol = getColumnCount();
  const restoreCount = Math.min(ncol * restoreRowBatch, gridWindow.startIndex);
  const start = gridWindow.startIndex - restoreCount;
  const rowHeight = measureRowHeight();
  const rowsRestored = Math.ceil(restoreCount / ncol);
  insertPhotoCards(state.photos.slice(start, gridWindow.startIndex), start, false);
  gridWindow.startIndex = start;
  gridWindow.topSpacerPx = Math.max(0, gridWindow.topSpacerPx - rowsRestored * rowHeight);
  updateTopSpacer();
  window.scrollBy(0, rowsRestored * rowHeight);
}

function scheduleRestoreTopRows() {
  if (restorePending || gridWindow.startIndex <= 0) return;
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
  state.elements.slideshowBtn?.classList.remove("is-active");
  state.elements.slideshowBtn?.setAttribute("aria-pressed", "false");
}

function pauseSlideshow() {
  if (!slideshow.active || slideshow.paused) return;
  slideshow.paused = true;
  if (slideshow.timer) {
    clearTimeout(slideshow.timer);
    slideshow.timer = null;
  }
}

function resumeSlideshow() {
  if (!slideshow.active || !slideshow.paused) return;
  slideshow.paused = false;
  scheduleSlideshowTick();
}

function toggleSlideshowPause() {
  if (!slideshow.active) return;
  if (slideshow.paused) {
    resumeSlideshow();
  } else {
    pauseSlideshow();
  }
}

function getSlideshowWait() {
  return (getKioskConfig().slideDuration || 12) * 1000;
}

function scheduleSlideshowTick() {
  if (slideshow.timer) {
    clearTimeout(slideshow.timer);
    slideshow.timer = null;
  }
  if (!slideshow.active || slideshow.paused) return;

  slideshow.timer = setTimeout(() => {
    slideshow.timer = null;
    if (!slideshow.active || slideshow.paused) return;

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

    showPreviewAt(next);
    scheduleSlideshowTick();
  }, getSlideshowWait());
}

function startSlideshow() {
  if (slideshow.active) return;
  slideshow.active = true;
  state.elements.slideshowBtn.classList.add("is-active");
  state.elements.slideshowBtn.setAttribute("aria-pressed", "true");
  if (!isPreviewOpen() && state.photos.length > 0) {
    showPreviewAt(0);
    $fullscreen.request().catch(() => {});
  }
  scheduleSlideshowTick();
}

function toggleSlideshow() {
  if (slideshow.active) {
    closePreview();
  } else {
    startSlideshow();
  }
}

function closePreview() {
  state.previewIndex = -1;
  state.elements.overlay?.classList.remove("is-open");
  state.elements.preview?.removeAttribute("src");
  document.documentElement.classList.remove("pg-preview-open");
  stopSlideshow();
  updatePreviewMeta();
  $fullscreen.exit().catch(() => {});
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

function showPreviewAt(index) {
  if (index < 0 || index >= state.photos.length) return;
  const photo = state.photos[index];
  state.previewIndex = index;
  const src = photo.hash ? fullUrl(photo.hash) : photo.fullSrc;
  state.elements.preview.src = src;
  state.elements.preview.setAttribute("src", src);
  state.elements.preview.alt = photo.title;
  state.elements.overlay.classList.add("is-open");
  document.documentElement.classList.add("pg-preview-open");
  updatePreviewMeta();
  state.elements.overlay.focus({ preventScroll: true });

  if (index >= state.photos.length - 4 && !state.done && !state.loading) {
    loadMore();
  }
}

function previewNext() {
  if (state.previewIndex < state.photos.length - 1) {
    showPreviewAt(state.previewIndex + 1);
    if (slideshow.active) scheduleSlideshowTick();
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
    if (slideshow.active) scheduleSlideshowTick();
  }
}

function completeAutoAdvanceIfNeeded(loadedOk) {
  if (!loadedOk || !autoAdvanceOnLoad) return;
  autoAdvanceOnLoad = false;
  const nextIndex = state.previewIndex + 1;
  if (nextIndex < state.photos.length) {
    showPreviewAt(nextIndex);
    if (slideshow.active) scheduleSlideshowTick();
  } else if (slideshow.active) {
    scheduleSlideshowTick();
  }
}

function getKioskConfig() {
  return window.__CONFIG__?.kioskConfig || config.kioskConfig || {};
}

function maybeStartKioskSlideshow() {
  if (!kioskBootPending || state.photos.length === 0) return;
  if (getKioskConfig().autoSlideshow !== true) return;
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
  if (state.done || state.photos.length >= backgroundFillTarget) {
    cancelBackgroundFill();
    return;
  }
  if (backgroundFillTimer || state.loading) return;
  if (!loadedOk) return;

  backgroundFillTimer = setTimeout(() => {
    backgroundFillTimer = null;
    if (!state.loading && !state.done && state.photos.length < backgroundFillTarget) {
      loadMore();
    }
  }, backgroundFillDelayMs);
}

function appendPhotos(rows) {
  const baseIndex = state.photos.length;
  state.photos.push(...rows);
  insertPhotoCards(rows, baseIndex, true);
  schedulePruneTopRows();
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
  return state.offset === 0 ? firstPageSize : pageSize;
}

async function loadMore() {
  if (state.loading || state.done) return;
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
  }, 15000);

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
    if (state.controller === controller) state.controller = null;
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
  autoAdvanceOnLoad = false;
  kioskBootPending = true;
  cancelBackgroundFill();
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
  resetRuntimeState();
  kioskBootPending = false;
  if (state.elements.grid) {
    state.elements.grid.querySelectorAll(".pg-card").forEach((node) => node.remove());
  }
  closePreview();
  setError("");
  renderState();
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
    $fullscreen.toggle().catch(() => {});
    return;
  }

  if (ev.key === "s" || ev.key === "S") {
    ev.preventDefault();
    toggleSlideshow();
    return;
  }

  if (isPreviewOpen()) {
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
}

function onAuxClick(ev) {
  if (ev.button !== 1) return;
  ev.preventDefault();
  $fullscreen.toggle().catch(() => {});
}

function onContextMenu(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  const now = Date.now();
  if (now - lastRightClickAt <= DOUBLE_CLICK_MS) {
    lastRightClickAt = 0;
    $fullscreen.toggle().catch(() => {});
    return;
  }
  lastRightClickAt = now;
  if (slideshow.active && !slideshow.paused) {
    pauseSlideshow();
  }
}

function onTouchStart(ev) {
  if (!isPreviewOpen() || !ev.changedTouches?.length) return;
  const t = ev.changedTouches[0];
  touch.x = t.clientX;
  touch.y = t.clientY;
}

function onTouchEnd(ev) {
  if (!isPreviewOpen() || !ev.changedTouches?.length) return;
  const t = ev.changedTouches[0];
  const dx = t.clientX - touch.x;
  const dy = t.clientY - touch.y;
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy)) return;
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
  preview.addEventListener("touchstart", onTouchStart, { passive: true });
  preview.addEventListener("touchend", onTouchEnd, { passive: true });

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
    if (ev.target === overlay) closePreview();
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
  if (listenersBound) return;
  listenersBound = true;
  document.addEventListener("keydown", onKeyDown, { capture: true });
  document.addEventListener("contextmenu", onContextMenu, { capture: true });
  document.addEventListener("auxclick", onAuxClick, { capture: true });
}

export async function bootMinimalPhotoApp(root) {
  if (!root) return;
  clearBootSplash();
  await ensureRuntimeConfig();
  $fullscreen.setVirtualOnly(getKioskConfig().virtualFullscreenOnly !== false);
  resetRuntimeState();
  buildUi(root);
  bindListeners();

  state.topObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        scheduleRestoreTopRows();
      }
    },
    { rootMargin: "400px 0px 0px 0px" }
  );
  state.topObserver.observe(state.elements.topSentinel);

  state.bottomObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMore();
      }
    },
    { rootMargin: "0px 0px 400px 0px" }
  );
  state.bottomObserver.observe(state.elements.sentinel);
  await loadMore();
  maybeScheduleBackgroundFill();
}
