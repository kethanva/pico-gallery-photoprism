import $fullscreen from "common/fullscreen";

const config = window.__CONFIG__ || {};
const staticUri = config.staticUri || "/static";
const apiUri = config.apiUri || "/api/v1";
const contentUri = config.contentUri || apiUri;
const previewToken = config.previewToken || "public";
const thumbSize = "fit_720";
const fullSize = "fit_1920";
const pageSize = 64;
const DOUBLE_CLICK_MS = 400;
const SWIPE_MIN_PX = 48;
const maxGridRows = 48;
const restoreRowBatch = 3;

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
  timer: null,
  wait: (config.kioskConfig?.slideDuration || 12) * 1000,
};

const touch = {
  x: 0,
  y: 0,
};

let lastRightClickAt = 0;
let listenersBound = false;

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
      thumbSrc: `${staticUri}/img/404.jpg`,
      fullSrc: `${staticUri}/img/404.jpg`,
    };
  }
  return {
    title,
    thumbSrc: `${contentUri}/t/${hash}/${previewToken}/${thumbSize}`,
    fullSrc: `${contentUri}/t/${hash}/${previewToken}/${fullSize}`,
  };
}

function getAuthToken() {
  try {
    const direct = localStorage.getItem("session.token");
    if (direct) {
      return direct;
    }
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.endsWith(":session.token")) {
        const value = localStorage.getItem(key);
        if (value) {
          return value;
        }
      }
    }
  } catch {
    return "";
  }
  return "";
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
  card.addEventListener("click", () => {
    showPreviewAt(index);
    $fullscreen.request().catch(() => {});
  }, { passive: true });

  const img = el("img", "pg-image");
  img.src = photo.thumbSrc;
  img.alt = photo.title;
  img.loading = "lazy";
  img.decoding = "async";
  if (index >= 12) {
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
    state.elements.grid.appendChild(frag);
  }
}

function pruneTopRowsIfNeeded() {
  const grid = state.elements.grid;
  const ncol = getColumnCount();
  const maxCards = maxGridRows * ncol;
  let cardCount = grid.querySelectorAll(".pg-card").length;
  while (cardCount > maxCards) {
    const rowHeight = measureRowHeight();
    const removeCount = Math.min(ncol, cardCount);
    for (let i = 0; i < removeCount; i += 1) {
      const first = grid.querySelector(".pg-card");
      if (!first) break;
      grid.removeChild(first);
    }
    gridWindow.startIndex += removeCount;
    gridWindow.topSpacerPx += rowHeight;
    updateTopSpacer();
    window.scrollBy(0, -rowHeight);
    cardCount = grid.querySelectorAll(".pg-card").length;
  }
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

function stopSlideshow() {
  slideshow.active = false;
  if (slideshow.timer) {
    clearTimeout(slideshow.timer);
    slideshow.timer = null;
  }
  state.elements.slideshowBtn?.classList.remove("is-active");
  state.elements.slideshowBtn?.setAttribute("aria-pressed", "false");
}

function scheduleSlideshowTick() {
  if (slideshow.timer) {
    clearTimeout(slideshow.timer);
    slideshow.timer = null;
  }
  if (!slideshow.active) return;

  slideshow.timer = setTimeout(() => {
    slideshow.timer = null;
    if (!slideshow.active) return;

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
        loadMore();
        scheduleSlideshowTick();
        return;
      }
    }

    showPreviewAt(next);
    scheduleSlideshowTick();
  }, slideshow.wait);
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
    stopSlideshow();
  } else {
    startSlideshow();
  }
}

function closePreview() {
  state.previewIndex = -1;
  state.elements.overlay?.classList.remove("is-open");
  state.elements.preview?.removeAttribute("src");
  stopSlideshow();
}

function showPreviewAt(index) {
  if (index < 0 || index >= state.photos.length) return;
  const photo = state.photos[index];
  state.previewIndex = index;
  state.elements.preview.src = photo.fullSrc;
  state.elements.preview.setAttribute("src", photo.fullSrc);
  state.elements.preview.alt = photo.title;
  state.elements.overlay.classList.add("is-open");

  if (index >= state.photos.length - 8 && !state.done && !state.loading) {
    loadMore();
  }
}

function previewNext() {
  if (state.previewIndex < state.photos.length - 1) {
    showPreviewAt(state.previewIndex + 1);
    if (slideshow.active) scheduleSlideshowTick();
  } else if (!state.done && !state.loading) {
    loadMore();
  }
}

function previewPrev() {
  if (state.previewIndex > 0) {
    showPreviewAt(state.previewIndex - 1);
    if (slideshow.active) scheduleSlideshowTick();
  }
}

function appendPhotos(rows) {
  const baseIndex = state.photos.length;
  state.photos.push(...rows);
  insertPhotoCards(rows, baseIndex, true);
  pruneTopRowsIfNeeded();
}

function renderState() {
  if (state.loading) {
    setStatus("Loading...");
  } else if (state.done && state.photos.length > 0) {
    setStatus("End of list");
  } else {
    setStatus("");
  }
}

function maybeFill() {
  if (state.loading || state.done) return;
  const rect = state.elements.sentinel.getBoundingClientRect();
  if (rect.top <= window.innerHeight + 1200) {
    loadMore();
  }
}

async function loadMore() {
  if (state.loading || state.done) return;
  state.loading = true;
  setError("");
  renderState();

  const generation = state.generation;
  const controller = new AbortController();
  state.controller = controller;
  let loadedOk = false;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15000);

  try {
    const url = new URL(`${apiUri.replace(/\/+$/, "")}/photos`, window.location.origin);
    url.searchParams.set("count", String(pageSize));
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

    const data = await response.json();
    if (generation !== state.generation) return;

    const rows = Array.isArray(data) ? data.map(mapPhoto) : [];
    state.offset += rows.length;
    appendPhotos(rows);

    if (rows.length < pageSize) {
      state.done = true;
    }
    loadedOk = true;
  } catch (err) {
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
    if (loadedOk && !state.done) {
      requestAnimationFrame(maybeFill);
    }
    if (slideshow.active && isPreviewOpen() && state.previewIndex >= state.photos.length - 1) {
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

  if (isPreviewOpen()) {
    if (ev.key === "ArrowRight") {
      ev.preventDefault();
      previewNext();
    } else if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      previewPrev();
    }
    return;
  }

  if (ev.key === "f" || ev.key === "F") {
    $fullscreen.toggle().catch(() => {});
  }
}

function onContextMenu(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  const now = Date.now();
  if (now - lastRightClickAt <= DOUBLE_CLICK_MS) {
    lastRightClickAt = 0;
    $fullscreen.toggle().catch(() => {});
  } else {
    lastRightClickAt = now;
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

function buildUi(root) {
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
  const topSentinel = el("div", "pg-top-sentinel");
  const grid = el("section", "pg-grid");
  const topSpacer = el("div", "pg-top-spacer");
  grid.appendChild(topSpacer);

  const sentinel = el("div", "pg-sentinel");
  const status = el("p", "pg-status");
  const overlay = el("div", "pg-overlay");
  const preview = el("img", "pg-preview");
  const close = el("button", "pg-close", "x");
  close.type = "button";
  close.setAttribute("aria-label", "Close preview");
  close.addEventListener("click", closePreview, { passive: true });
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) closePreview();
  });
  overlay.addEventListener("touchstart", onTouchStart, { passive: true });
  overlay.addEventListener("touchend", onTouchEnd, { passive: true });
  overlay.append(preview, close);

  shell.append(header, error, topSentinel, grid, sentinel, status, overlay);
  root.appendChild(shell);

  state.elements = {
    error,
    topSentinel,
    grid,
    topSpacer,
    sentinel,
    status,
    overlay,
    preview,
    slideshowBtn,
  };
}

function bindListeners() {
  if (listenersBound) return;
  listenersBound = true;
  window.addEventListener("keydown", onKeyDown);
  document.addEventListener("contextmenu", onContextMenu, { capture: true });
}

export function bootMinimalPhotoApp(root) {
  if (!root) return;
  resetRuntimeState();
  buildUi(root);
  bindListeners();

  state.topObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        restoreTopRowsIfNeeded();
      }
    },
    { rootMargin: "800px 0px 0px 0px" }
  );
  state.topObserver.observe(state.elements.topSentinel);

  state.bottomObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMore();
      }
    },
    { rootMargin: "0px 0px 1200px 0px" }
  );
  state.bottomObserver.observe(state.elements.sentinel);
  loadMore();
}
