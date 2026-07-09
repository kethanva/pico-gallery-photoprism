const config = window.__CONFIG__ || {};
const staticUri = config.staticUri || "/static";
const apiUri = config.apiUri || "/api/v1";
const contentUri = config.contentUri || apiUri;
const previewToken = config.previewToken || "public";
const thumbSize = "fit_720";
const fullSize = "fit_1920";
const pageSize = 64;
const maxDomCards = 220;

const state = {
  photoCount: 0,
  offset: 0,
  loading: false,
  done: false,
  error: "",
  generation: 0,
  controller: null,
  observer: null,
  elements: {},
};

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

function pickHash(item) {
  if (typeof item?.Hash === "string" && item.Hash) return item.Hash;
  if (!Array.isArray(item?.Files)) return "";
  const primary = item.Files.find((f) => f?.Primary && f?.Hash);
  if (primary?.Hash) return primary.Hash;
  const fallback = item.Files.find((f) => !f?.Missing && f?.Hash);
  return fallback?.Hash || "";
}

function mapPhoto(item) {
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

function closePreview() {
  state.elements.overlay.classList.remove("is-open");
}

function openPreview(photo) {
  state.elements.preview.src = photo.fullSrc;
  state.elements.preview.alt = photo.title;
  state.elements.overlay.classList.add("is-open");
}

function pruneGridIfNeeded() {
  const grid = state.elements.grid;
  while (grid.children.length > maxDomCards) {
    grid.removeChild(grid.firstChild);
  }
}

function appendPhotos(rows) {
  const frag = document.createDocumentFragment();
  rows.forEach((photo, index) => {
    const card = el("button", "pg-card");
    card.type = "button";
    card.title = photo.title;
    card.addEventListener("click", () => openPreview(photo), { passive: true });

    const img = el("img", "pg-image");
    img.src = photo.thumbSrc;
    img.alt = photo.title;
    img.loading = "lazy";
    img.decoding = "async";
    if (index > 11) {
      img.fetchPriority = "low";
    }
    card.appendChild(img);
    frag.appendChild(card);
  });
  state.elements.grid.appendChild(frag);
  pruneGridIfNeeded();
}

function renderState() {
  if (state.loading) {
    setStatus("Loading...");
  } else if (state.done && state.photoCount > 0) {
    setStatus("End of list");
  } else {
    setStatus("");
  }
}

// maybeFill re-triggers a load when the sentinel is still within the prefetch
// zone after a page settled. Without it, IntersectionObserver never re-fires
// (no intersection transition) and loading stalls when a page fails to fill
// the viewport + prefetch margin.
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
    state.photoCount += rows.length;
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
  }
}

function resetAndReload() {
  state.generation += 1;
  if (state.controller) {
    state.controller.abort();
    state.controller = null;
  }
  state.loading = false;
  state.done = false;
  state.offset = 0;
  state.photoCount = 0;
  state.elements.grid.textContent = "";
  setError("");
  renderState();
  loadMore();
}

function onKeyDown(ev) {
  if (ev.key === "Escape") {
    closePreview();
  }
}

function buildUi(root) {
  root.textContent = "";
  const shell = el("main", "pg-shell");
  const header = el("header", "pg-header");
  const title = el("h1", "pg-title", "Photos");
  const reload = el("button", "pg-button", "Reload");
  reload.type = "button";
  reload.addEventListener("click", resetAndReload, { passive: true });
  header.append(title, reload);

  const error = el("p", "pg-error");
  const grid = el("section", "pg-grid");
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
  overlay.append(preview, close);

  shell.append(header, error, grid, sentinel, status, overlay);
  root.appendChild(shell);

  state.elements = { error, grid, sentinel, status, overlay, preview };
}

export function bootMinimalPhotoApp(root) {
  if (!root) return;
  buildUi(root);
  window.addEventListener("keydown", onKeyDown);

  state.observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMore();
      }
    },
    { rootMargin: "0px 0px 1200px 0px" }
  );
  state.observer.observe(state.elements.sentinel);
  loadMore();
}
