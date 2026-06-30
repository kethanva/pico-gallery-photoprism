import type { Transition } from '@pico/shared';

export async function runTransition(
  entering: HTMLElement,
  leaving: HTMLElement,
  transition: Transition,
  ms: number
): Promise<void> {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const actual = reducedMotion ? 'cut' : transition;

  document.documentElement.style.setProperty('--transition-ms', `${ms}ms`);

  entering.dataset['transition'] = actual;
  leaving.dataset['transition'] = actual;
  entering.classList.add('entering');
  leaving.classList.add('leaving');

  // 'cut' has no animation, so swap instantly — but still fall through to the
  // cleanup below. Returning early here would leave the .entering/.leaving
  // classes on the layers and corrupt the next transition.
  if (actual !== 'cut') {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  entering.classList.remove('entering');
  leaving.classList.remove('leaving');
  delete entering.dataset['transition'];
  delete leaving.dataset['transition'];
}
