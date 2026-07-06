import { fetchPlaylist, shuffle } from './playlist.js';
import { Slideshow } from './slideshow.js';
import { PhotoGrid } from './grid.js';
import { bindInput } from './input.js';

const BOOT_RETRY_BASE_MS = 2000;
const BOOT_RETRY_MAX_MS = 30000;

const app = document.getElementById('app');
const loading = document.getElementById('loading');

/** @type {'slideshow' | 'grid'} */
let surface = 'slideshow';
/** @type {import('./playlist.js').Photo[]} */
let library = [];
/** @type {import('./playlist.js').Photo[]} */
let slideshowOrder = [];

const slideshow = new Slideshow(document.createElement('div'));
const grid = new PhotoGrid(document.createElement('div'));
app.appendChild(slideshow.root);
app.appendChild(grid.root);

grid.onSelect = (idx) => {
  const photo = library[idx];
  if (!photo) return;
  const orderIdx = slideshow.order.findIndex((p) => p.hash === photo.hash);
  showSlideshow(orderIdx >= 0 ? orderIdx : 0);
};

// Tap / left-click on the slideshow opens the photo grid. Touch frames have no
// keyboard — without this the fullscreen slideshow ignores taps entirely and
// the frame reads as unresponsive.
slideshow.root.addEventListener('click', () => {
  if (surface === 'slideshow') showGrid();
});

function showSlideshow(startIndex = 0) {
  surface = 'slideshow';
  grid.hide();
  slideshow.reveal();
  slideshow.goTo(startIndex);
}

function showGrid() {
  surface = 'grid';
  slideshow.hide();
  grid.show();
}

function toggleSurface() {
  if (surface === 'slideshow') showGrid();
  else showSlideshow(slideshow.index);
}

bindInput({
  onToggle: toggleSurface,
  onPause: () => { if (surface === 'slideshow') slideshow.togglePause(); },
  onNext: () => { if (surface === 'slideshow') slideshow.next(); },
  onPrev: () => { if (surface === 'slideshow') slideshow.prev(); },
  onEscape: () => showGrid(),
});

async function loadBootData() {
  const [playlist, frameCfg, ppCfg] = await Promise.all([
    fetchPlaylist(),
    fetch('/config.json').then((r) => r.json()).catch(() => ({})),
    // The PhotoPrism config is required — without its previewToken every thumb
    // URL 403s and the frame shows nothing but black slides.
    fetch('/api/v1/config').then((r) => {
      if (!r.ok) throw new Error(`config ${r.status}`);
      return r.json();
    }),
  ]);
  if (!playlist.length) throw new Error('playlist empty');
  return { playlist, frameCfg, ppCfg };
}

async function boot() {
  // Cold boot on the Pi: Wi-Fi and the PhotoPrism backend usually come up
  // AFTER this page loads. A single failed fetch must not leave a dead black
  // frame until the daily kiosk recycle — retry with backoff until the
  // library arrives.
  for (let attempt = 1; ; attempt++) {
    try {
      const { playlist, frameCfg, ppCfg } = await loadBootData();

      library = playlist;
      slideshowOrder = shuffle(playlist.slice());

      const previewToken = ppCfg.previewToken || ppCfg.downloadToken || 'public';
      slideshow.setPreviewToken(previewToken);
      grid.setPreviewToken(previewToken);

      const slideDuration = frameCfg.kioskConfig?.slideDuration || frameCfg.slideDuration || 10;
      slideshow.setSlideDuration(slideDuration);

      grid.setPhotos(library);
      slideshow.start(slideshowOrder, 0);

      loading.classList.add('hidden');
      return;
    } catch (err) {
      console.error('[boot]', err);
      const delay = Math.min(BOOT_RETRY_BASE_MS * 2 ** (attempt - 1), BOOT_RETRY_MAX_MS);
      loading.textContent = `Waiting for PhotoPrism… (attempt ${attempt}, retrying in ${Math.round(delay / 1000)}s)`;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

boot();
