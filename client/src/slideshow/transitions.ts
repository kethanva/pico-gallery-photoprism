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

  if (actual === 'cut') return;

  await new Promise<void>((resolve) => setTimeout(resolve, ms));

  entering.classList.remove('entering');
  leaving.classList.remove('leaving');
  delete entering.dataset['transition'];
  delete leaving.dataset['transition'];
}
