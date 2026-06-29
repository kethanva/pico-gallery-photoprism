import './styles/tokens.css';
import './styles/frame.css';
import { SlideshowStage } from './slideshow/stage.js';
import { OSDOverlay } from './overlay/osd.js';
import { ClockOverlay } from './overlay/clock.js';
import { NightMode } from './overlay/night.js';
import { DisconnectBadge } from './overlay/disconnect.js';
import { SlideshowEventSource } from './api/events.js';
import { api } from './api/client.js';
import type { DisplayConfig, SlideshowState } from '@pico/shared';
import { mountRemote } from './control/remote.js';

async function waitForReady(maxWaitMs = 120_000): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch('/api/v1/ready');
      if (r.ok) return;
    } catch {}
    await new Promise((res) => setTimeout(res, 2000));
  }
}

async function mountFrame(root: HTMLElement): Promise<void> {
  // Show loading indicator while server loads sources
  root.innerHTML = '<div class="pico-loading" aria-live="polite">Loading…</div>';
  await waitForReady();

  const cfg: DisplayConfig = await api.getConfig().catch(() => ({
    slideDurationSecs: 10,
    transition: 'fade' as const,
    transitionMs: 800,
    fillScreen: false,
    letterboxBlur: true,
    kenBurns: false,
    showOsd: true,
    showClock: false,
    order: 'shuffle' as const,
    onThisDayBoost: true,
    maxImageMb: 100,
    maxMegapixels: 64,
  }));

  root.innerHTML = '<div class="pico-stage" id="stage"></div>';
  const stage = root.querySelector<HTMLElement>('#stage')!;

  const slideStage = new SlideshowStage(stage);
  const osd = cfg.showOsd ? new OSDOverlay(stage) : null;
  const clock = cfg.showClock ? new ClockOverlay(stage) : null;
  const night = new NightMode(stage, cfg.night);
  const badge = new DisconnectBadge(stage);

  // Blackout overlay for the display on/off schedule (server emits `display` and
  // carries `displayOn` in state). When off, the frame goes black on the Pi too.
  const blank = document.createElement('div');
  blank.className = 'display-off';
  stage.appendChild(blank);
  const setDisplay = (on: boolean): void => blank.classList.toggle('visible', !on);

  clock?.start();
  night.start();

  let lastState: SlideshowState | null = null;

  const es = new SlideshowEventSource();
  es.onConnect(() => badge.hide());
  es.onDisconnect(() => badge.show());
  es.onDisplay(setDisplay);
  es.onState(async (state) => {
    if (lastState?.photo?.id !== state.photo?.id) {
      await slideStage.show(state, cfg);
      if (cfg.showOsd) osd?.show(state);
    }
    setDisplay(state.displayOn);
    lastState = state;
  });
  es.connect();

  // Re-request the current photo at the new viewport size after a resize/rotate,
  // so the frame always shows display-sized bytes (no upscaling blur).
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (lastState?.photo) void slideStage.show(lastState, cfg);
    }, 300);
  });
}

const root = document.querySelector<HTMLElement>('#app')!;

if (window.location.pathname.startsWith('/remote')) {
  mountRemote(root);
} else {
  mountFrame(root).catch(console.error);
}
