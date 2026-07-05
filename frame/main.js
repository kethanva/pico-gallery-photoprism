import { fetchPlaylist, shuffle } from './playlist.js';
import { Slideshow } from './slideshow.js';
import { PhotoGrid } from './grid.js';
import { bindInput } from './input.js';

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

async function boot() {
  try {
    const [playlist, frameCfg, ppCfg] = await Promise.all([
      fetchPlaylist(),
      fetch('/config.json').then((r) => r.json()).catch(() => ({})),
      fetch('/api/v1/config').then((r) => r.json()).catch(() => ({})),
    ]);

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
  } catch (err) {
    loading.textContent = 'Failed to load photos. Check the PhotoPrism connection.';
    console.error(err);
  }
}

boot();
